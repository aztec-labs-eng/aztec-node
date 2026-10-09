import { sleep } from '@aztec-labs/foundation/sleep';
import type { AztecAsyncKVStore } from '@aztec-labs/kv-store';
import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { GENESIS_BLOCK_HEADER_HASH } from '@aztec-labs/stdlib/block';
import type { PublishedCheckpoint } from '@aztec-labs/stdlib/checkpoint';
import { SiloedTag } from '@aztec-labs/stdlib/logs';
import type { AppendOnlyTreeSnapshot } from '@aztec-labs/stdlib/trees';
import { jest } from '@jest/globals';

import { makeCheckpointWithLogs } from '../test/mock_structs.js';
import { BlockStore } from './block_store.js';
import { LogStore } from './log_store.js';

const BLOCKS_TO_SEED = 5;
const TXS_PER_BLOCK = 4;
const LOGS_PER_TX = 5;
const TAGS_PER_QUERY = 100;

/** Number of artificial write transactions queued in front of the contended read. */
const QUEUED_WRITES = 5;
/** Duration of each artificial write transaction. */
const WRITE_DURATION_MS = 50;

describe('LogStore write contention', () => {
  jest.setTimeout(60_000);

  let db: AztecAsyncKVStore;
  let blockStore: BlockStore;
  let logStore: LogStore;
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

    const blocks = checkpoints.map(c => c.checkpoint.blocks[0]);
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

  it('returns the same results for a tag query racing queued write transactions', async () => {
    const baseline = await logStore.getPrivateLogsByTags({ tags, includeEffects: true });

    // Fill the store's serial writer queue without awaiting it, so the query below races these writes.
    const writes = Array.from({ length: QUEUED_WRITES }, () => db.transactionAsync(() => sleep(WRITE_DURATION_MS)));

    const contended = await logStore.getPrivateLogsByTags({ tags, includeEffects: true });

    expect(contended).toHaveLength(TAGS_PER_QUERY);
    expect(contended.every(logs => logs.length > 0)).toBe(true);
    expect(contended).toEqual(baseline);

    await Promise.all(writes);
  });
});
