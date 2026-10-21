import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import type { ViemPublicClient } from '@aztec-labs/ethereum/types';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
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
    tracker.start();
    // Wait until a poll has actually read the older block, so the assertion below is about that read.
    await retryUntil(
      () => rollup.getManaLimit.mock.calls.some(([opts]) => opts?.blockNumber === 9n) || undefined,
      'poll',
      5,
      0.01,
    );
    expect(tracker.getFeeConfig()).toEqual(expectedAt(11n, raisedValues));
  });

  it('does not move the latest value back when serving an older pinned read', async () => {
    governanceUpdate(raisedValues);
    tracker = await RollupFeeConfigTracker.create(rollup);

    expect(await tracker.getFeeConfigAt(10n)).toEqual(expectedAt(10n, initialValues));
    expect(tracker.getFeeConfig()).toEqual(expectedAt(11n, raisedValues));
  });

  it('advances the latest value from a newer pinned read', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup);
    governanceUpdate(raisedValues);

    expect(await tracker.getFeeConfigAt(11n)).toEqual(expectedAt(11n, raisedValues));
    expect(tracker.getFeeConfig()).toEqual(expectedAt(11n, raisedValues));
  });

  it('shares an in-flight pinned read and caches it afterwards', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup);
    const gate = promiseWithResolvers<bigint>();
    rollup.getManaLimit.mockImplementationOnce(() => gate.promise);
    const readsAtBlock = (blockNumber: bigint) =>
      rollup.getManaLimit.mock.calls.filter(([opts]) => opts?.blockNumber === blockNumber).length;

    const first = tracker.getFeeConfigAt(7n);
    const second = tracker.getFeeConfigAt(7n);
    gate.resolve(initialValues.manaLimit);

    expect(await first).toEqual(expectedAt(7n, initialValues));
    expect(await second).toEqual(expectedAt(7n, initialValues));
    expect(await tracker.getFeeConfigAt(7n)).toEqual(expectedAt(7n, initialValues));
    expect(readsAtBlock(7n)).toBe(1);
  });

  it('evicts the least recently used pinned read once it is full', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup, { pinnedReadsCapacity: 2 });
    const readsAtBlock = (blockNumber: bigint) =>
      rollup.getManaLimit.mock.calls.filter(([opts]) => opts?.blockNumber === blockNumber).length;

    await tracker.getFeeConfigAt(1n);
    await tracker.getFeeConfigAt(2n);
    // Using block 1 again makes block 2 the least recently used, so block 3 pushes block 2 out.
    await tracker.getFeeConfigAt(1n);
    await tracker.getFeeConfigAt(3n);
    await tracker.getFeeConfigAt(1n);
    await tracker.getFeeConfigAt(2n);

    expect(readsAtBlock(1n)).toBe(1);
    expect(readsAtBlock(2n)).toBe(2);
  });

  it("polls with the client's cached block number", async () => {
    tracker = await RollupFeeConfigTracker.create(rollup, { pollingIntervalMs: 10 });
    tracker.start();

    await retryUntil(() => client.getBlockNumber.mock.calls.length > 2 || undefined, 'poll', 5, 0.01);
    expect(client.getBlockNumber.mock.calls.every(args => args.length === 0)).toBe(true);
  });

  it('retries a pinned read that failed', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup);
    rollup.getManaLimit.mockRejectedValueOnce(new Error('rpc down'));

    await expect(tracker.getFeeConfigAt(7n)).rejects.toThrow('rpc down');
    expect(await tracker.getFeeConfigAt(7n)).toEqual(expectedAt(7n, initialValues));
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
