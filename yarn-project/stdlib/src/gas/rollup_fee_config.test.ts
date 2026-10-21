import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import type { ViemPublicClient } from '@aztec-labs/ethereum/types';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { type MockProxy, mock } from 'jest-mock-extended';

import { type RollupFeeConfig, RollupFeeConfigTracker } from './rollup_fee_config.js';

type FeeValues = Omit<RollupFeeConfig, 'l1BlockNumber'>;

const initialValues: FeeValues = {
  manaTarget: 50_000_000n,
  manaLimit: 100_000_000n,
  provingCostPerManaInEth: 100n,
  protocolFeeMarginBps: 1000,
};

const raisedValues: FeeValues = { ...initialValues, manaTarget: 75_000_000n, manaLimit: 150_000_000n };

describe('RollupFeeConfigTracker', () => {
  let client: MockProxy<ViemPublicClient>;
  let rollup: MockProxy<RollupContract>;
  /** The L1 block the RPC reports as latest. */
  let head: bigint;
  /** Fee values in force from each L1 block on, oldest first. */
  let history: { fromBlock: bigint; values: FeeValues }[];
  let tracker: RollupFeeConfigTracker | undefined;

  /** Fee values in force at the given L1 block. */
  const valuesAt = (blockNumber: bigint | undefined): FeeValues =>
    history.findLast(entry => entry.fromBlock <= (blockNumber ?? head))!.values;

  /** Governance changes the values at a new L1 block, which becomes the head. */
  const governanceUpdate = (values: FeeValues) => {
    head += 1n;
    history.push({ fromBlock: head, values });
  };

  const expectedAt = (l1BlockNumber: bigint, values: FeeValues): RollupFeeConfig => ({ ...values, l1BlockNumber });

  beforeEach(() => {
    head = 10n;
    history = [{ fromBlock: 0n, values: initialValues }];

    client = mock<ViemPublicClient>();
    client.getBlockNumber.mockImplementation(() => Promise.resolve(head));

    rollup = mock<RollupContract>({ client });
    rollup.getManaTarget.mockImplementation(opts => Promise.resolve(valuesAt(opts?.blockNumber).manaTarget));
    rollup.getManaLimit.mockImplementation(opts => Promise.resolve(valuesAt(opts?.blockNumber).manaLimit));
    rollup.getProvingCostPerMana.mockImplementation(opts =>
      Promise.resolve(valuesAt(opts?.blockNumber).provingCostPerManaInEth),
    );
    rollup.getProtocolFeeMargin.mockImplementation(opts =>
      Promise.resolve(valuesAt(opts?.blockNumber).protocolFeeMarginBps),
    );
  });

  afterEach(async () => {
    await tracker?.stop();
    tracker = undefined;
  });

  it('reads the config when created', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup);

    expect(tracker.getFeeConfig()).toEqual(expectedAt(10n, initialValues));
  });

  it('picks up a governance update from its own polling loop', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup, { pollingIntervalMs: 10 });
    tracker.start();
    governanceUpdate(raisedValues);

    await retryUntil(() => tracker!.getFeeConfig().manaLimit === raisedValues.manaLimit || undefined, 'poll', 5, 0.01);
    expect(tracker.getFeeConfig()).toEqual(expectedAt(11n, raisedValues));
  });

  it('keeps the newer value when a lagging RPC node reports an older block', async () => {
    governanceUpdate(raisedValues);
    tracker = await RollupFeeConfigTracker.create(rollup, { pollingIntervalMs: 10 });

    head = 9n;
    client.getBlockNumber.mockClear();
    tracker.start();
    // Wait until a few polls have seen the older block, so the assertion below is about them.
    await retryUntil(() => client.getBlockNumber.mock.calls.length >= 3 || undefined, 'poll', 5, 0.01);
    expect(tracker.getFeeConfig()).toEqual(expectedAt(11n, raisedValues));
  });

  it("polls with the client's cached block number", async () => {
    tracker = await RollupFeeConfigTracker.create(rollup, { pollingIntervalMs: 10 });
    tracker.start();

    await retryUntil(() => client.getBlockNumber.mock.calls.length > 2 || undefined, 'poll', 5, 0.01);
    expect(client.getBlockNumber.mock.calls.every(args => args.length === 0)).toBe(true);
  });

  it('keeps the last value while a poll fails, and picks up the change once one succeeds', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup, { pollingIntervalMs: 10 });
    governanceUpdate(raisedValues);
    rollup.getManaLimit.mockRejectedValueOnce(new Error('rpc down')).mockRejectedValueOnce(new Error('rpc down'));
    tracker.start();

    // The create read plus the two failing polls: while those fail, the value stays at the create read.
    await retryUntil(() => rollup.getManaLimit.mock.calls.length >= 3 || undefined, 'failing polls', 5, 0.01);
    expect(tracker.getFeeConfig()).toEqual(expectedAt(10n, initialValues));

    await retryUntil(() => tracker!.getFeeConfig().manaLimit === raisedValues.manaLimit || undefined, 'poll', 5, 0.01);
    expect(tracker.getFeeConfig()).toEqual(expectedAt(11n, raisedValues));
  });
});
