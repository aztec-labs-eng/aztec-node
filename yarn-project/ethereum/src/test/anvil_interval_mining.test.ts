import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { sleep } from '@aztec-labs/foundation/sleep';
import { TestDateProvider } from '@aztec-labs/foundation/timer';
import { createPublicClient, http } from 'viem';
import { foundry } from 'viem/chains';

import { EthCheatCodes } from './eth_cheat_codes.js';
import { type Anvil, startAnvil } from './start_anvil.js';

const INTERVAL = 2;
// How late a block may be observed after the node clock reaches its timestamp. Covers the 25ms poll, the RPC
// round trips of a mine, and a short cheat op holding the queue, but not a restarted anvil interval timer.
const MAX_LAG_MS = 300;

/**
 * Runs anvil the way the e2e setup does: interval mining at a fixed block time, blocks stamped `prev + interval`,
 * and a node clock synced to the freshly mined block that starts the grid.
 */
describe('anvil interval mining', () => {
  let anvil: Anvil;
  let rpcUrl: string;
  let dateProvider: TestDateProvider;
  let cheatCodes: EthCheatCodes;
  let observer: ReturnType<typeof createPublicClient>;

  beforeEach(async () => {
    dateProvider = new TestDateProvider();
    ({ anvil, rpcUrl } = await startAnvil({ port: 0, l1BlockTime: INTERVAL, dateProvider, clientSideMining: true }));
    cheatCodes = new EthCheatCodes([rpcUrl], dateProvider);
    observer = createPublicClient({ chain: foundry, transport: http(rpcUrl, { batch: false }) });
    await cheatCodes.setBlockInterval(INTERVAL);
    await cheatCodes.startIntervalMiningWithFreshBlock(INTERVAL);
  });

  afterEach(async () => {
    await anvil?.stop();
  });

  /** Polls for the first block above `after`, recording when the node clock saw it. */
  const nextBlock = async (after: bigint) => {
    for (let i = 0; i < 400; i++) {
      const block = await observer.getBlock({ blockTag: 'latest' });
      if (block.number > after) {
        return { number: block.number, timestamp: Number(block.timestamp), seenAt: dateProvider.now() };
      }
      await sleep(25);
    }
    throw new Error(`No block above ${after} was mined`);
  };

  /** Asserts the next `count` blocks are each stamped one interval after their parent and mined on time. */
  const expectBlocksOnGrid = async (parent: { number: bigint; timestamp: number }, count: number) => {
    let prev = parent;
    for (let i = 0; i < count; i++) {
      const block = await nextBlock(prev.number);
      expect(block.number).toEqual(prev.number + 1n);
      expect(block.timestamp).toEqual(prev.timestamp + INTERVAL);
      expect(block.seenAt - block.timestamp * 1000).toBeLessThan(MAX_LAG_MS);
      prev = block;
    }
  };

  it('keeps mining on the grid after an atomic cheat op one second into a cycle', async () => {
    const start = await observer.getBlock({ blockTag: 'latest' });
    const cycleStart = await nextBlock(start.number);
    await sleep(1000);

    const account = EthAddress.random();
    await cheatCodes.execWithPausedAnvil(async () => {
      const value = await cheatCodes.load(account, 1n);
      await sleep(200);
      await cheatCodes.store(account, 1n, value + 1n, { silent: true });
    });
    expect(await cheatCodes.load(account, 1n)).toEqual(1n);

    await expectBlocksOnGrid(cycleStart, 3);
  });

  it('does not interleave a mine with a read-modify-write held past the block due time', async () => {
    const start = await observer.getBlock({ blockTag: 'latest' });
    const cycleStart = await nextBlock(start.number);
    const account = EthAddress.random();

    let releasedAt = 0;
    const blocksSeenInside = await cheatCodes.execWithPausedAnvil(async () => {
      const before = await cheatCodes.blockNumber();
      const value = await cheatCodes.load(account, 1n);
      // The next block falls due while the lock is held.
      await sleep(INTERVAL * 1000 + 300);
      await cheatCodes.store(account, 1n, value + 1n, { silent: true });
      const after = await cheatCodes.blockNumber();
      releasedAt = dateProvider.now();
      return { before, after };
    });

    expect(blocksSeenInside.after).toEqual(blocksSeenInside.before);
    expect(BigInt(blocksSeenInside.before)).toEqual(cycleStart.number);

    // The deferred block lands as soon as the lock is released, still stamped one interval after its parent.
    const deferred = await nextBlock(cycleStart.number);
    expect(deferred.timestamp).toEqual(cycleStart.timestamp + INTERVAL);
    expect(deferred.seenAt - releasedAt).toBeLessThan(MAX_LAG_MS);
    await expectBlocksOnGrid(deferred, 2);
  });

  it('catches up with the grid after a lock held for several intervals', async () => {
    const start = await observer.getBlock({ blockTag: 'latest' });
    const cycleStart = await nextBlock(start.number);
    await cheatCodes.execWithPausedAnvil(() => sleep(INTERVAL * 2500));

    // Blocks stay stamped one interval apart while the miner works off the lag, two blocks per interval at most.
    let prev = { number: cycleStart.number, timestamp: cycleStart.timestamp };
    let lagMs = Infinity;
    for (let i = 0; i < 8 && lagMs >= MAX_LAG_MS; i++) {
      const block = await nextBlock(prev.number);
      expect(block.timestamp).toEqual(prev.timestamp + INTERVAL);
      lagMs = block.seenAt - block.timestamp * 1000;
      prev = block;
    }
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
    await expectBlocksOnGrid(prev, 2);
  });

  it('mines nothing once interval mining is turned off', async () => {
    const start = await observer.getBlock({ blockTag: 'latest' });
    await nextBlock(start.number);
    await cheatCodes.setIntervalMining(0);
    const stoppedAt = await observer.getBlockNumber({ cacheTime: 0 });

    await sleep(INTERVAL * 2500);
    expect(await observer.getBlockNumber({ cacheTime: 0 })).toEqual(stoppedAt);
    expect(await cheatCodes.getIntervalMining()).toBeNull();
  });

  it('serializes requests from separate cheat code instances behind a held lock', async () => {
    const other = new EthCheatCodes([rpcUrl], dateProvider);
    const account = EthAddress.random();

    let otherReadAt = 0;
    let releasedAt = 0;
    const held = cheatCodes.execWithPausedAnvil(async () => {
      await sleep(500);
      await cheatCodes.store(account, 1n, 7n, { silent: true });
      releasedAt = Date.now();
    });
    await sleep(50);
    const read = other.load(account, 1n).then(value => {
      otherReadAt = Date.now();
      return value;
    });

    await held;
    expect(await read).toEqual(7n);
    expect(otherReadAt).toBeGreaterThanOrEqual(releasedAt);
  });
});
