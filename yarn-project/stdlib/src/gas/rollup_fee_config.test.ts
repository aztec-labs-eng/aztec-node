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

  it('picks up a governance update on refresh', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup);
    governanceUpdate(raisedValues);

    expect(await tracker.refresh()).toEqual(expectedAt(11n, raisedValues));
    expect(tracker.getFeeConfig()).toEqual(expectedAt(11n, raisedValues));
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
    tracker = await RollupFeeConfigTracker.create(rollup);

    head = 9n;
    expect(await tracker.refresh()).toEqual(expectedAt(11n, raisedValues));
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

  it('retries a pinned read that failed', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup);
    rollup.getManaLimit.mockRejectedValueOnce(new Error('rpc down'));

    await expect(tracker.getFeeConfigAt(7n)).rejects.toThrow('rpc down');
    expect(await tracker.getFeeConfigAt(7n)).toEqual(expectedAt(7n, initialValues));
  });

  it('rejects a refresh that fails, keeping the last value', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup);
    governanceUpdate(raisedValues);
    rollup.getManaLimit.mockRejectedValueOnce(new Error('rpc down'));

    // A caller about to reject on the cached limit must learn that the re-read failed, not get the stale value back.
    await expect(tracker.refresh()).rejects.toThrow('rpc down');
    expect(tracker.getFeeConfig()).toEqual(expectedAt(10n, initialValues));
  });

  it('keeps polling after a refresh fails', async () => {
    tracker = await RollupFeeConfigTracker.create(rollup, { pollingIntervalMs: 10 });
    governanceUpdate(raisedValues);
    rollup.getManaLimit.mockRejectedValueOnce(new Error('rpc down')).mockRejectedValueOnce(new Error('rpc down'));
    tracker.start();

    await retryUntil(() => tracker!.getFeeConfig().manaLimit === raisedValues.manaLimit || undefined, 'poll', 5, 0.01);
    expect(tracker.getFeeConfig()).toEqual(expectedAt(11n, raisedValues));
  });
});
