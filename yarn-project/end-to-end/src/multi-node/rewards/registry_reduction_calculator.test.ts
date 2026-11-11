import {
  MockATPAbi,
  MockATPBytecode,
  MockATPStakerAbi,
  MockATPStakerBytecode,
  RegistryReductionCalculatorAbi,
  RegistryReductionCalculatorBytecode,
  RollupAbi,
  TestERC20Abi,
} from '@aztec-foundation/l1-artifacts';

import { EthAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { GSEContract } from '@aztec-labs/ethereum/contracts';
import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import type { L1ContractAddresses } from '@aztec-labs/ethereum/l1-contract-addresses';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import { asyncMap } from '@aztec-labs/foundation/async-map';
import { minBigint } from '@aztec-labs/foundation/bigint';
import { CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { jest } from '@jest/globals';
import { type Hex, getContract } from 'viem';

import type { TestWallet } from '../../test-wallet/test_wallet.js';
import { startMempoolFeeder } from '../../test-wallet/utils.js';
import {
  MultiNodeTestContext,
  type RegisteredValidator,
  buildMockGossipValidators,
} from '../multi_node_test_context.js';

jest.setTimeout(1000 * 60 * 20);

/** The ATP registries the test stakes through. Any non-zero address works: the mock ATPs only report it. */
const ZERO_REWARD_REGISTRY = EthAddress.fromNumber(0xa);
const DEFAULT_REWARD_REGISTRY = EthAddress.fromNumber(0xb);

/**
 * The checkpoint reward governance sets: orders of magnitude above the fees of a checkpoint (about 1e18 here), so the
 * reward and fee portions of a payout cannot be confused, while the reward distributor still funds hundreds of them.
 */
const CHECKPOINT_REWARD = 100_000n * 10n ** 18n;

/**
 * A committee of EOA-staked and ATP-staked validators, each with its own coinbase, proposes checkpoints carrying txs
 * while a prover node proves every epoch. The rollup's sequencer reward calculator is a `RegistryReductionCalculator`
 * paying nothing to proposals by validators staked through ATPs of one registry, and the default to everyone else.
 * After every epoch proof, each coinbase's sequencer rewards on L1 must equal what its proven checkpoints earn: the
 * calculator's reward, plus the sequencer share of the fees of the txs in them.
 */
describe('multi-node/rewards/registry_reduction_calculator', () => {
  let test: MultiNodeTestContext;

  afterEach(async () => {
    await test?.teardown();
  });

  it('pays each proposer its registry reward plus its checkpoint fees', async () => {
    // One validator per ATP registry and two EOA validators, in a committee of all four so that one validator missing
    // a slot still leaves a quorum. Proposers are drawn uniformly per slot, so a single validator of a kind is what
    // bounds the wait for the stop condition: about six slots on average for both ATP validators to have proposed.
    const validators = buildMockGossipValidators(4);
    const eoaValidators = validators.slice(0, 2);
    const [zeroRewardAtpValidator, defaultRewardAtpValidator] = validators.slice(2);
    const atpValidators = [
      { validator: zeroRewardAtpValidator, registry: ZERO_REWARD_REGISTRY },
      { validator: defaultRewardAtpValidator, registry: DEFAULT_REWARD_REGISTRY },
    ];
    let calculator!: EthAddress;

    test = await MultiNodeTestContext.setup({
      numberOfAccounts: 0,
      initialValidators: eoaValidators,
      aztecTargetCommitteeSize: validators.length,
      mockGossipSubNetwork: true,
      startProverNode: true,
      skipInitialSequencer: true,
      aztecEpochDuration: 4,
      ethereumSlotDuration: 4,
      aztecSlotDuration: 36,
      blockDurationMs: 6000,
      attestationPropagationTime: 0.5,
      minTxsPerBlock: 0,
      pxeOpts: { syncChainTip: 'checkpointed' },
      // ATP validators cannot be initial validators: their stakers, the GSE withdrawers the calculator resolves, are
      // contracts. This hook runs before the setup advances to the first epoch with a committee.
      deployExtraL1Contracts: async ({ l1Client, deployL1ContractsValues: { l1ContractAddresses } }) => {
        await depositThroughAtps(l1Client, l1ContractAddresses, atpValidators);
        calculator = await deployCalculator(l1Client, l1ContractAddresses.gseAddress!);
      },
    });
    const { context, logger, rollup, l1Client } = test;

    await context.cheatCodes.rollup.asOwner(async (governance, rollupAsGovernance) => {
      const { sequencerBps } = await rollupAsGovernance.read.getRewardConfig();
      const asGovernance = { account: governance };
      await mined(
        l1Client,
        rollupAsGovernance.write.setSequencerRewardCalculator([calculator.toString()], asGovernance),
      );
      await mined(
        l1Client,
        rollupAsGovernance.write.setRewardConfig([{ sequencerBps, checkpointReward: CHECKPOINT_REWARD }], asGovernance),
      );
    });
    const { checkpointReward, sequencerBps } = await rollup.getRewardConfig();
    const defaultReward = (checkpointReward * sequencerBps) / 10_000n;
    logger.warn(`Installed calculator ${calculator} with a default reward of ${defaultReward} per checkpoint`, {
      calculator: calculator.toString(),
      defaultReward,
    });

    expect((await rollup.getAttesters()).map(a => a.toString()).sort()).toEqual(
      validators.map(v => v.attester.toString()).sort(),
    );
    const calculatorContract = getContract({
      address: calculator.toString(),
      abi: RegistryReductionCalculatorAbi,
      client: l1Client,
    });
    for (const { validator, registry } of atpValidators) {
      const [resolved, resolvedRegistry] = await calculatorContract.read.resolveRegistry([
        validator.attester.toString(),
      ]);
      expect({ resolved, registry: EthAddress.fromString(resolvedRegistry) }).toEqual({ resolved: true, registry });
    }

    const nodes = await asyncMap(validators, ({ privateKey }) =>
      test.createValidatorNode([privateKey], { dontStartSequencer: true }),
    );
    const wallet = context.wallet as TestWallet;
    wallet.updateNode(nodes[0]);
    const contract = await test.registerTestContract(wallet);
    await test.startSequencers(nodes);
    let nullifier = 1;
    await using _feeder = startMempoolFeeder(
      wallet,
      nodes[0],
      () => contract.methods.emit_nullifier(new Fr(nullifier++)),
      { from: context.accounts[0], minPending: 2, logger },
    );

    // What each coinbase has earned from the proven checkpoints: the calculator's reward per checkpoint it proposed,
    // plus the sequencer fee the rollup derives from the checkpoint's accumulated fees and its stored fee header.
    // Every validator node runs a single validator key and no configured coinbase, so it is paid at its attester.
    const earned = new Map(validators.map(v => [v.attester.toString(), { reward: 0n, fees: 0n }]));
    const rewardOf = (coinbase: EthAddress) => (coinbase.equals(zeroRewardAtpValidator.attester) ? 0n : defaultReward);
    const paidFees = (validator: RegisteredValidator) => earned.get(validator.attester.toString())!.fees > 0n;
    let accounted = 0;

    await retryUntil(
      async () => {
        // The proven tip and the rewards are read at the same L1 block, so a proof landing in between cannot skew them.
        const blockNumber = await l1Client.getBlockNumber();
        const proven = await rollup.getProvenCheckpointNumber({ blockNumber });
        if (proven <= accounted) {
          return false;
        }
        const checkpoints = await nodes[0].getCheckpoints(CheckpointNumber(accounted + 1), proven - accounted);
        if (checkpoints.length < proven - accounted) {
          return false;
        }
        for (const { number, header } of checkpoints) {
          const fee = header.accumulatedFees.toBigInt();
          const { manaUsed, protocolFee, proverCost } = await rollup.getFeeHeader(BigInt(number));
          const feeAfterProtocol = fee - manaUsed * protocolFee;
          const sequencerFee = feeAfterProtocol - minBigint(manaUsed * proverCost, feeAfterProtocol);
          expect([...earned.keys()]).toContain(header.coinbase.toString());
          const coinbase = earned.get(header.coinbase.toString())!;
          coinbase.reward += rewardOf(header.coinbase);
          coinbase.fees += sequencerFee;
          logger.warn(`Proven checkpoint ${number} by ${header.coinbase} earns ${sequencerFee} in fees`, {
            checkpointNumber: number,
            coinbase: header.coinbase.toString(),
            fee,
            sequencerFee,
          });
        }
        accounted = proven;

        for (const [coinbase, { reward, fees }] of earned) {
          const onChain = await rollup.getSequencerRewards(coinbase as Hex, { blockNumber });
          logger.warn(`Sequencer rewards of ${coinbase} at proven checkpoint ${proven}`, { onChain, reward, fees });
          expect({ coinbase, onChain }).toEqual({ coinbase, onChain: reward + fees });
        }
        return atpValidators.every(({ validator }) => paidFees(validator)) && eoaValidators.some(paidFees);
      },
      'a proven checkpoint with txs by a validator of each kind',
      test.L2_SLOT_DURATION_IN_S * test.epochDuration * 6,
      1,
    );
  });
});

/**
 * Stakes each validator through a mock ATP of its registry, with the ATP's mock staker as the GSE withdrawer, and
 * flushes the entry queue so they are active once the committee is sampled.
 */
async function depositThroughAtps(
  l1Client: ExtendedViemWalletClient,
  { rollupAddress, gseAddress, stakingAssetAddress }: L1ContractAddresses,
  validators: { validator: RegisteredValidator; registry: EthAddress }[],
) {
  const rollup = getContract({ address: rollupAddress.toString(), abi: RollupAbi, client: l1Client });
  const stakingAsset = getContract({ address: stakingAssetAddress.toString(), abi: TestERC20Abi, client: l1Client });
  const gse = new GSEContract(l1Client, gseAddress!);

  const stake = (await rollup.read.getActivationThreshold()) * BigInt(validators.length);
  await mined(l1Client, stakingAsset.write.mint([l1Client.account.address, stake]));
  await mined(l1Client, stakingAsset.write.approve([rollup.address, stake]));
  for (const { validator, registry } of validators) {
    const { address: atp } = await deployL1Contract(l1Client, MockATPAbi, MockATPBytecode, [registry.toString()]);
    const { address: staker } = await deployL1Contract(l1Client, MockATPStakerAbi, MockATPStakerBytecode, [
      atp.toString(),
    ]);
    const { publicKeyInG1, publicKeyInG2, proofOfPossession } = await gse.makeRegistrationTuple(
      validator.bn254SecretKey.getValue(),
    );
    await mined(
      l1Client,
      rollup.write.deposit([
        validator.attester.toString(),
        staker.toString(),
        publicKeyInG1,
        publicKeyInG2,
        proofOfPossession,
        false,
      ]),
    );
  }
  await mined(l1Client, rollup.write.flushEntryQueue());
}

/** Deploys a `RegistryReductionCalculator` owned by the deployer that pays nothing to `ZERO_REWARD_REGISTRY`. */
async function deployCalculator(l1Client: ExtendedViemWalletClient, gseAddress: EthAddress): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    l1Client,
    RegistryReductionCalculatorAbi,
    RegistryReductionCalculatorBytecode,
    [gseAddress.toString(), l1Client.account.address],
  );
  const calculator = getContract({
    address: address.toString(),
    abi: RegistryReductionCalculatorAbi,
    client: l1Client,
  });
  await mined(l1Client, calculator.write.setRegistryReward([ZERO_REWARD_REGISTRY.toString(), 0n]));
  return address;
}

/** Awaits the receipt of an L1 tx and fails on a revert, which `waitForTransactionReceipt` alone does not. */
async function mined(l1Client: ExtendedViemWalletClient, hash: Promise<Hex>) {
  const receipt = await l1Client.waitForTransactionReceipt({ hash: await hash });
  expect(receipt.status).toEqual('success');
}
