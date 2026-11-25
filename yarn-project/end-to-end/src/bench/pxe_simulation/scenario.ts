import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { type AztecNode, createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { prepareChonkProofInputs } from '@aztec-labs/bb-prover/client';
import { type JsonRpcFetch, defaultFetch } from '@aztec-labs/foundation/json-rpc/client';
import { Timer, elapsed } from '@aztec-labs/foundation/timer';
import { AMMContract } from '@aztec-labs/noir-contracts.js/AMM';
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC';
import { TestTokenContract } from '@aztec-labs/noir-test-contracts.js/TestToken';
import type { ContractArtifact } from '@aztec-labs/stdlib/abi';
import { ContractInstanceWithAddressSchema } from '@aztec-labs/stdlib/contract';
import type { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { Buffer } from 'buffer';

/**
 * The transactions the benchmark measures, run by one user's wallet.
 *
 * The user holds private notes of two tokens, banana and candy, which an AMM pairs. The scenario's transactions add
 * liquidity to the AMM with both tokens and transfer candy to the admin, the account that deployed the contracts and
 * mints the user's notes; it also reads the user's candy balance. A sponsored FPC pays the fees.
 */
export type Scenario = {
  /** Sends the scenario's transactions, adding them to the user's history. */
  sendTxs(): Promise<void>;
  /**
   * Times every operation once. It sends nothing, so the user's state is the same before and after, but it mines blocks
   * with other users' transactions, so that each simulation has a block to sync.
   */
  measure(): Promise<Measurement[]>;
};

/** The value of each token note minted to the user. */
export const AMOUNT_PER_NOTE = 1_000_000n;

/** How many notes of each token one AMM add_liquidity spends. */
const ADD_LIQUIDITY_NOTES = 3;

/** How many notes one token transfer spends. */
const TRANSFER_NOTES = 2;

/** Token notes of each kind that one {@link Scenario.sendTxs} spends. */
export const NOTES_PER_SEND = { banana: ADD_LIQUIDITY_NOTES, candy: ADD_LIQUIDITY_NOTES + TRANSFER_NOTES };

/** How many transactions one {@link Scenario.sendTxs} sends. */
export const TXS_PER_SEND = 2;

/** The smallest amount that takes `notes` notes to pay. */
function amountSpending(notes: number) {
  return BigInt(notes - 1) * AMOUNT_PER_NOTE + 1n;
}

/**
 * What a scenario needs from the network setup: the node, the user's account keys and the contracts it uses. Every
 * value is a string, so the config can be handed to a browser page.
 */
export type ScenarioConfig = {
  /** The node's JSON-RPC URL. */
  nodeUrl: string;
  /** The account's secret and salt, and its ECDSA signing key as hex. */
  account: { secret: string; salt: string; signingKey: string };
  admin: string;
  /** Contract instances, as JSON. */
  contracts: Record<'banana' | 'candy' | 'amm' | 'liquidityToken' | 'sponsoredFPC', string>;
};

/** How long one operation took on the user's side, and how many round trips to the node it waited on. */
export type Measurement = { operation: string; clientMs: number; roundTrips: number };

/**
 * Creates the user's wallet with `createWallet` and returns the scenario it runs.
 *
 * `mineBlock` mines a block the user is not involved in.
 */
export async function createScenario(
  config: ScenarioConfig,
  {
    createWallet,
    mineBlock,
  }: { createWallet: (node: AztecNode) => Promise<EmbeddedWallet>; mineBlock: () => Promise<void> },
): Promise<Scenario> {
  const roundTrips = recordRoundTrips();
  const wallet = await createWallet(createAztecNodeClient(config.nodeUrl, { fetch: roundTrips.fetch }));

  const { account } = config;
  const { address: user } = await wallet.createECDSARAccount(
    Fr.fromHexString(account.secret),
    Fr.fromHexString(account.salt),
    Buffer.from(account.signingKey, 'hex'),
  );
  const admin = AztecAddress.fromStringUnsafe(config.admin);
  await wallet.registerSender(admin, 'admin');

  const register = async (name: keyof ScenarioConfig['contracts'], artifact: ContractArtifact) => {
    const instance = ContractInstanceWithAddressSchema.parse(JSON.parse(config.contracts[name]));
    await wallet.registerContract(instance, artifact);
    return instance.address;
  };
  const banana = TestTokenContract.at(await register('banana', TestTokenContract.artifact), wallet);
  const candy = TestTokenContract.at(await register('candy', TestTokenContract.artifact), wallet);
  const amm = AMMContract.at(await register('amm', AMMContract.artifact), wallet);
  await register('liquidityToken', TestTokenContract.artifact);
  const sponsoredFPC = await register('sponsoredFPC', SponsoredFPCContract.artifact);

  const options = { from: user, fee: { paymentMethod: new SponsoredFeePaymentMethod(sponsoredFPC) } };

  const addLiquidity = async () => {
    const amount = amountSpending(ADD_LIQUIDITY_NOTES);
    const nonce = Fr.random();
    const authWitnesses = await Promise.all(
      [banana, candy].map(async token =>
        wallet.createAuthWit(user, {
          caller: amm.address,
          call: await token.methods
            .transfer_to_public_and_prepare_private_balance_increase(user, amm.address, amount, nonce)
            .getFunctionCall(),
        }),
      ),
    );
    return amm.methods.add_liquidity(amount, amount, amount, amount, nonce).with({ authWitnesses });
  };
  const transfer = () => candy.methods.transfer(admin, amountSpending(TRANSFER_NOTES));

  return {
    async sendTxs() {
      await (await addLiquidity()).send(options);
      await transfer().send(options);
    },

    async measure() {
      const measurements: Measurement[] = [];
      const time = async <T>(operation: string, fn: () => T | Promise<T>): Promise<T> => {
        const before = { ...roundTrips.totals };
        const [wallMs, result] = await elapsed(fn);
        measurements.push({
          operation,
          clientMs: wallMs - (roundTrips.totals.waitMs - before.waitMs),
          roundTrips: roundTrips.totals.count - before.count,
        });
        return result;
      };

      // Witness generation runs on the block its simulation synced, as it does when a wallet sends the transaction.
      const timeTx = async (name: string, interaction: ContractFunctionInteraction) => {
        await mineBlock();
        await time(`${name}/simulate`, () => interaction.simulate(options));
        const { executionSteps } = await time(`${name}/witgen`, () =>
          interaction.profile({ ...options, profileMode: 'execution-steps', skipProofGeneration: true }),
        );
        await time(`${name}/prepare_proof_inputs`, () => prepareChonkProofInputs(executionSteps));
      };

      await timeTx('amm_add_liquidity', await addLiquidity());
      await timeTx('transfer', transfer());
      await mineBlock();
      await time('balance_of_private/simulate', () => candy.methods.balance_of_private(user).simulate({ from: user }));
      return measurements;
    },
  };
}

/**
 * A node client transport that counts the round trips its requests make, and the time spent waiting for them.
 *
 * A round trip starts when a request goes out with none in flight and ends when the last one in flight returns, so
 * concurrent requests count once.
 */
function recordRoundTrips(): { fetch: JsonRpcFetch; totals: { count: number; waitMs: number } } {
  const totals = { count: 0, waitMs: 0 };
  let inFlight = 0;
  let roundTrip = new Timer();
  const fetch: JsonRpcFetch = async (...args) => {
    if (inFlight++ === 0) {
      roundTrip = new Timer();
    }
    try {
      return await defaultFetch(...args);
    } finally {
      if (--inFlight === 0) {
        totals.count++;
        totals.waitMs += roundTrip.ms();
      }
    }
  };
  return { fetch, totals };
}
