import type { AztecAsyncKVStore } from '@aztec-labs/kv-store';
import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { GENESIS_BLOCK_HEADER_HASH, type L2Block } from '@aztec-labs/stdlib/block';
import type { PublishedCheckpoint } from '@aztec-labs/stdlib/checkpoint';
import { SiloedTag } from '@aztec-labs/stdlib/logs';
import type { AppendOnlyTreeSnapshot } from '@aztec-labs/stdlib/trees';
import { jest } from '@jest/globals';

import { makeCheckpointWithLogs } from '../test/mock_structs.js';
import { BlockStore } from './block_store.js';
import { LogStore } from './log_store.js';

const BLOCKS_TO_SEED = 20;
const TXS_PER_BLOCK = 1;
const LOGS_PER_TX = 5;
const TAGS_PER_QUERY = 100;

describe('LogStore write contention', () => {
  jest.setTimeout(60_000);

  let db: AztecAsyncKVStore;
  let blockStore: BlockStore;
  let logStore: LogStore;
  let blocks: L2Block[];
  let tags: SiloedTag[];

  beforeEach(async () => {
    db = await openTmpStore('log_store_write_contention_test');
    blockStore = new BlockStore(db);
    logStore = new LogStore(db, blockStore, GENESIS_BLOCK_HEADER_HASH);

    const checkpoints: PublishedCheckpoint[] = [];
    let previousArchive: AppendOnlyTreeSnapshot | undefined;
    for (let blockNumber = 1; blockNumber <= BLOCKS_TO_SEED; blockNumber++) {
      const checkpoint = await makeCheckpointWithLogs(blockNumber, {
        numTxsPerBlock: TXS_PER_BLOCK,
        privateLogs: { numLogsPerTx: LOGS_PER_TX },
        previousArchive,
      });
      previousArchive = checkpoint.checkpoint.blocks[0].archive;
      checkpoints.push(checkpoint);
    }

    blocks = checkpoints.map(c => c.checkpoint.blocks[0]);
    await blockStore.addCheckpoints(checkpoints);
    await logStore.addLogs(blocks);

    const harvested = blocks.flatMap(block =>
      block.body.txEffects.flatMap(txEffect => txEffect.privateLogs.map(log => new SiloedTag(log.fields[0]))),
    );
    tags = Array.from({ length: TAGS_PER_QUERY }, (_, i) => harvested[i % harvested.length]);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('returns a coherent state for a tag query racing queued write transactions', async () => {
    const baseline = await logStore.getPrivateLogsByTags({ tags, includeEffects: true });

    // Queue one write per block (but the first) that drops that block's logs, without awaiting them. The writes commit
    // one at a time in queue order, so the only coherent states are "the first k blocks' deletions applied". The
    // writes are kept short so that, were the query not isolated from them, some would likely commit between its
    // per-tag scans and the test would see a torn result.
    const deletedBlocks = blocks.slice(1);
    const writes = deletedBlocks.map(block => logStore.deleteLogs([block]));

    const contended = await logStore.getPrivateLogsByTags({ tags, includeEffects: true });
    await Promise.all(writes);

    const coherentStates = Array.from({ length: deletedBlocks.length + 1 }, (_, applied) => {
      const deleted = new Set(deletedBlocks.slice(0, applied).map(block => block.number));
      return baseline.map(logs => logs.filter(log => !deleted.has(log.blockNumber)));
    });
    expect(contended).toHaveLength(TAGS_PER_QUERY);
    expect(coherentStates).toContainEqual(contended);

    // once every write has landed, only the first block's logs are left
    await expect(logStore.getPrivateLogsByTags({ tags, includeEffects: true })).resolves.toEqual(
      coherentStates[deletedBlocks.length],
    );
  });
});
