import { NO_FROM } from '@aztec-labs/aztec.js/account';
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { FeeJuicePaymentMethodWithClaim } from '@aztec-labs/aztec.js/fee';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { median, timesAsync } from '@aztec-labs/foundation/collection';
import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { createNamespacedSafeJsonRpcServer, startHttpRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import { AztecNodeApiSchema } from '@aztec-labs/stdlib/interfaces/client';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mintNotes } from '../../fixtures/token_utils.js';
import { ClientFlowsBenchmark } from '../client_flows/client_flows_benchmark.js';
import type { GithubActionBenchmarkResult } from '../utils.js';
import { AMOUNT_PER_NOTE, NOTES_PER_SEND, type Scenario, type ScenarioConfig, TXS_PER_SEND } from './scenario.js';

/** How many times each operation is measured in each state. */
const ITERATIONS = 5;

/**
 * How many times the user sends the scenario's transactions before the second measurement, so that it runs on an
 * account with a history: the notes and tags a PXE has stored change how long it takes to sync and simulate.
 *
 * There's an upper bound because no blocks are finalized during the run, and an unconstrained delivery tag stream has a
 * maximum number of unfinalized used tags. Each round's mints to the user use more of them.
 */
const HISTORY_ROUNDS = 5;

/**
 * Sets up the network a {@link Scenario} runs against, and measures it on a fresh account and again after the account
 * has sent transactions.
 */
export class PxeSimulationBenchmark {
  private readonly t = new ClientFlowsBenchmark('pxe_simulation', {
    // A prover node proves epochs in the background, competing for the CPU with the operations being timed.
    startProverNode: false,
    // With nothing proving epochs, the default proof window would end during the run and the chain would be pruned.
    aztecProofSubmissionEpochs: 100,
  });
  private nodeServer?: Awaited<ReturnType<typeof startHttpRpcServer>>;
  private user?: AztecAddress;

  /**
   * Starts a network with an AMM and its tokens, deploys the user's account and serves the node over JSON-RPC, as a
   * user's wallet would reach it.
   */
  async setup(): Promise<ScenarioConfig> {
    const t = this.t;
    await t.setup();
    await t.applyDeployBananaToken();
    await t.applyDeployCandyBarToken();
    await t.applyDeployAmm();
    await t.applyDeploySponsoredFPC();

    const secret = Fr.random();
    const salt = Fr.random();
    const signingKey = randomBytes(32);
    const account = await t.adminWallet.createECDSARAccount(secret, salt, signingKey);
    const claim = await t.feeJuiceBridgeTestHarness.prepareTokensOnL1(account.address);
    await (
      await account.getDeployMethod()
    ).send({ from: NO_FROM, fee: { paymentMethod: new FeeJuicePaymentMethodWithClaim(account.address, claim) } });
    this.user = account.address;

    this.nodeServer = await startHttpRpcServer(
      createNamespacedSafeJsonRpcServer({ aztec: [t.aztecNode, AztecNodeApiSchema] }),
      { host: '127.0.0.1' },
    );

    return {
      nodeUrl: `http://127.0.0.1:${this.nodeServer.port}`,
      account: { secret: secret.toString(), salt: salt.toString(), signingKey: signingKey.toString('hex') },
      admin: t.adminAddress.toString(),
      contracts: {
        banana: jsonStringify(t.bananaCoinInstance),
        candy: jsonStringify(t.candyBarCoinInstance),
        amm: jsonStringify(t.ammInstance),
        liquidityToken: jsonStringify(t.liquidityTokenInstance),
        sponsoredFPC: jsonStringify(t.sponsoredFPCInstance),
      },
    };
  }

  async teardown() {
    this.nodeServer?.close();
    await this.t.teardown();
  }

  /** Mines a block with a transaction the user is not involved in. */
  readonly mineBlock = async () => {
    await this.t.bananaCoin.methods.mint_to_public(this.t.adminAddress, 1n).send({ from: this.t.adminAddress });
  };

  /**
   * Measures `scenario` on the user's fresh account and again after it has sent transactions, and writes the medians to
   * the file the `BENCH_OUTPUT` environment variable names.
   */
  async run(environment: 'node' | 'browser', scenario: Scenario) {
    const results: GithubActionBenchmarkResult[] = [];
    const measure = async (state: string) => {
      await this.mintNotesForOneSend();
      const measurements = (await timesAsync(ITERATIONS, () => scenario.measure())).flat();
      for (const [operation, runs] of Object.entries(Object.groupBy(measurements, m => m.operation))) {
        const name = `pxe_simulation/${environment}/${state}/${operation}`;
        results.push(
          { name: `${name}/client_ms`, value: median(runs!.map(r => r.clientMs))!, unit: 'ms' },
          { name: `${name}/round_trips`, value: median(runs!.map(r => r.roundTrips))!, unit: 'round_trips' },
        );
      }
    };

    await measure('fresh');
    for (let i = 0; i < HISTORY_ROUNDS; i++) {
      await this.mintNotesForOneSend();
      await scenario.sendTxs();
    }
    await measure(`after_${HISTORY_ROUNDS * TXS_PER_SEND}_txs`);

    this.t.logger.info('PXE simulation benchmark results', Object.fromEntries(results.map(r => [r.name, r.value])));
    if (process.env.BENCH_OUTPUT) {
      await mkdir(path.dirname(process.env.BENCH_OUTPUT), { recursive: true });
      await writeFile(process.env.BENCH_OUTPUT, JSON.stringify(results));
    }
  }

  /** Mints the user the notes one round of the scenario's transactions spends. */
  private async mintNotesForOneSend() {
    const { adminWallet, adminAddress, bananaCoin, candyBarCoin } = this.t;
    const notes = (count: number) => Array(count).fill(AMOUNT_PER_NOTE);
    await mintNotes(adminWallet, adminAddress, this.user!, bananaCoin, notes(NOTES_PER_SEND.banana));
    await mintNotes(adminWallet, adminAddress, this.user!, candyBarCoin, notes(NOTES_PER_SEND.candy));
  }
}
