import { Fr } from '@aztec-labs/aztec.js/fields';
import { createLogger } from '@aztec-labs/aztec.js/log';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';

import { type InsertingBlockNodeView, findInsertingBlock } from './find_inserting_block.js';

describe('findInsertingBlock', () => {
  const log = createLogger('test:find-inserting-block');
  const msgHash = new Fr(42);
  /** The message occupies leaf index 2, inserted by block 3 of a five-block chain. */
  const leafIndex = 2n;
  const insertingBlockNumber = 3;
  const tip = 5;

  /** Leaf counts per block number: the message's index is first covered at {@link insertingBlockNumber}. */
  const leafCountAt = (blockNumber: number) => (blockNumber < insertingBlockNumber ? 2 : 3);

  /**
   * A node serving the fixture chain above, failing the first `failures` historical reads (block data and
   * membership witnesses) before answering normally, as a chain moving under a search does.
   */
  const nodeFailingHistoricalReads = (failures: number): InsertingBlockNodeView & { historicalReads: number } => {
    let remainingFailures = failures;
    const consumeFailure = () => {
      if (remainingFailures > 0) {
        remainingFailures--;
        throw new Error('World state does not have block 3');
      }
    };
    const view = {
      historicalReads: 0,
      getL1ToL2MessageIndex: () => Promise.resolve(leafIndex),
      getBlockNumber: () => Promise.resolve(BlockNumber(tip)),
      getBlockData: (query: { number?: number } | number) => {
        view.historicalReads++;
        const number = typeof query === 'number' ? query : query.number!;
        consumeFailure();
        return Promise.resolve({
          blockHash: `0xblock${number}`,
          checkpointNumber: 1,
          indexWithinCheckpoint: number - 1,
          header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: leafCountAt(number) } } },
        });
      },
      getL1ToL2MessageMembershipWitness: (blockNumber: number) => {
        view.historicalReads++;
        consumeFailure();
        return Promise.resolve(blockNumber >= insertingBlockNumber ? [leafIndex] : undefined);
      },
    };
    return view as unknown as InsertingBlockNodeView & { historicalReads: number };
  };

  it('locates the block whose leaf count first covers the message index', async () => {
    const node = nodeFailingHistoricalReads(0);

    await expect(findInsertingBlock(node, msgHash, log)).resolves.toMatchObject({
      blockNumber: insertingBlockNumber,
      blockHash: `0xblock${insertingBlockNumber}`,
    });
  });

  it('retries the whole attempt when a historical read throws, and still locates the block', async () => {
    const node = nodeFailingHistoricalReads(1);

    await expect(findInsertingBlock(node, msgHash, log)).resolves.toMatchObject({
      blockNumber: insertingBlockNumber,
    });
  });

  it('gives up after the attempt budget and reports the last failure as the cause', async () => {
    const node = nodeFailingHistoricalReads(Number.MAX_SAFE_INTEGER);

    await expect(findInsertingBlock(node, msgHash, log, { attempts: 2, timeoutSeconds: 1 })).rejects.toThrow(
      /Could not confirm which block inserted/,
    );
    await findInsertingBlock(node, msgHash, log, { attempts: 2, timeoutSeconds: 1 }).catch(err => {
      expect((err as Error).cause).toBeInstanceOf(Error);
      expect(((err as Error).cause as Error).message).toMatch(/World state does not have block/);
    });
  });
});
