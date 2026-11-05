import type { CheckpointProposedLog } from '@aztec-labs/ethereum/contracts';
import type { L1BlockId } from '@aztec-labs/ethereum/l1-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import type { AztecAsyncKVStore } from '@aztec-labs/kv-store';
import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import type { PublishedCheckpoint } from '@aztec-labs/stdlib/checkpoint';
import { RpcRequestError } from 'viem';

import { BlockStore } from '../store/block_store.js';
import { makeBlockHash, makeChainedCheckpoints } from '../test/mock_structs.js';
import { type L1HistoryEndpoint, checkL1RpcHistory } from './validate_historical_logs.js';

const L1_START_BLOCK = 10n;

/** The L1 block hashes the mock checkpoints are stored with. */
const canonicalHash = (l1BlockNumber: bigint) => Buffer32.fromString(makeBlockHash(Number(l1BlockNumber)));

type FakeEndpointOptions = {
  /** Answers log queries below this L1 block with an empty result, as a node that silently drops pruned logs does. */
  emptyBelow?: bigint;
  /** Fails every log query with this error. */
  logsError?: Error;
  /** Holds different blocks than the local data, as an endpoint on the other side of a reorg does. */
  forked?: boolean;
};

describe('checkL1RpcHistory', () => {
  const addresses = { rollupAddress: EthAddress.random(), inboxAddress: EthAddress.random() };
  const l1Start: L1BlockId = { l1BlockNumber: L1_START_BLOCK, l1BlockHash: canonicalHash(L1_START_BLOCK) };
  const log = createLogger('archiver:test:validate_historical_logs');

  let db: AztecAsyncKVStore;
  let blocks: BlockStore;
  let published: PublishedCheckpoint[];

  beforeEach(async () => {
    db = await openTmpStore('validate_historical_logs_test');
    blocks = new BlockStore(db);
    published = [];
  });

  afterEach(async () => {
    await db.delete();
  });

  /** Publishes checkpoints ten L1 blocks apart from L1 block 100 and stores them locally. */
  const addCheckpoints = async (count: number) => {
    published = await makeChainedCheckpoints(count, { startL1BlockNumber: 100, txsPerBlock: 1 });
    await blocks.addCheckpoints(published);
  };

  const makeEndpoint = (url: string, opts: FakeEndpointOptions = {}): L1HistoryEndpoint => {
    const queryLogs = <T>(fromBlock: bigint, logs: T[]): Promise<T[]> => {
      if (opts.logsError) {
        return Promise.reject(opts.logsError);
      }
      return Promise.resolve(opts.forked || fromBlock < (opts.emptyBelow ?? 0n) ? [] : logs);
    };
    return {
      url,
      getBlockHash: blockNumber => Promise.resolve(opts.forked ? Buffer32.random() : canonicalHash(blockNumber)),
      getClientVersion: () => Promise.resolve('reth/v2.6.0'),
      rollup: {
        getOwnershipTransferredEventsAtDeploy: () => queryLogs(L1_START_BLOCK, [{ blockNumber: L1_START_BLOCK }]),
        getCheckpointProposedEvents: (fromBlock, toBlock) =>
          queryLogs(
            fromBlock,
            published
              .filter(({ l1 }) => l1.blockNumber >= fromBlock && l1.blockNumber <= toBlock)
              .map(
                ({ checkpoint, l1 }): CheckpointProposedLog => ({
                  l1BlockNumber: l1.blockNumber,
                  l1BlockHash: canonicalHash(l1.blockNumber),
                  l1TransactionHash: Buffer32.random().toString(),
                  l1TransactionIndex: 0,
                  l1LogIndex: 0,
                  args: {
                    checkpointNumber: checkpoint.number,
                    archive: checkpoint.archive.root,
                    versionedBlobHashes: [],
                    attestationsHash: Buffer32.ZERO,
                    payloadDigest: Buffer32.ZERO,
                  },
                }),
              ),
          ),
      },
    };
  };

  const check = (endpoints: L1HistoryEndpoint[], skipCheck = false) =>
    checkL1RpcHistory(endpoints, blocks, l1Start, addresses, skipCheck, log);

  describe('with local checkpoints', () => {
    beforeEach(async () => {
      await addCheckpoints(3);
    });

    it('passes a URL that serves the latest checkpoint event but has pruned deployment logs', async () => {
      await expect(check([makeEndpoint('http://full-node', { emptyBelow: 110n })])).resolves.toBeUndefined();
    });

    it('fails when a URL returns no event from the latest checkpoint block, even alongside a serving URL', async () => {
      const endpoints = [makeEndpoint('http://archive'), makeEndpoint('http://pruned', { emptyBelow: 1000n })];

      await expect(check(endpoints)).rejects.toThrow(/L1 RPC at http:\/\/pruned \(client reth\/v2\.6\.0\)/);
    });

    it('continues past an empty result when the check is skipped', async () => {
      await expect(check([makeEndpoint('http://pruned', { emptyBelow: 1000n })], true)).resolves.toBeUndefined();
    });

    it('continues when URLs answer error 4444 or fail, leaving sync to use the URLs that work', async () => {
      const pruned = new RpcRequestError({
        body: {},
        error: { code: 4444, message: 'pruned history unavailable' },
        url: 'http://fake',
      });
      const endpoints = [
        makeEndpoint('http://errors-on-pruned', { logsError: pruned }),
        makeEndpoint('http://down', { logsError: new Error('connection refused') }),
      ];

      await expect(check(endpoints)).resolves.toBeUndefined();
    });

    it('continues when a URL holds another block at the latest checkpoint height', async () => {
      await expect(check([makeEndpoint('http://reorged', { forked: true })])).resolves.toBeUndefined();
    });
  });

  describe('with no local checkpoint', () => {
    it('passes a URL that serves the deployment event', async () => {
      await expect(check([makeEndpoint('http://archive')])).resolves.toBeUndefined();
    });

    it('fails when a URL returns no deployment event', async () => {
      await expect(check([makeEndpoint('http://full-node', { emptyBelow: 110n })])).rejects.toThrow(
        /no Rollup deployment OwnershipTransferred event from L1 block 10/,
      );
    });
  });
});
