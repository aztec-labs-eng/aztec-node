import { INITIAL_L2_BLOCK_NUM } from '@aztec-labs/constants';
import { asyncPool } from '@aztec-labs/foundation/async-pool';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { createLogger } from '@aztec-labs/foundation/log';
import type { AztecAsyncKVStore, AztecAsyncMap } from '@aztec-labs/kv-store';
import type { BlockHash, L2Block } from '@aztec-labs/stdlib/block';
import { MAX_LOGS_PER_TAG } from '@aztec-labs/stdlib/interfaces/api-limit';
import type {
  LogCursor,
  LogResult,
  PrivateLogsQuery,
  PublicLogsQuery,
  ResolvedLogsQuery,
  SiloedTag,
  Tag,
  TagQuery,
} from '@aztec-labs/stdlib/logs';
import type { TxHash } from '@aztec-labs/stdlib/tx';

import type { BlockStore } from './block_store.js';
import {
  decodeKeyTail,
  decodeValue,
  encodeKey,
  encodePublicPrefix,
  encodeValue,
  endOfTagRange,
  endOfTxRange,
  fieldHex,
  incKey,
  tagHexForLog,
} from './log_store_codec.js';

const TAG_SCAN_CONCURRENCY = 8;

/**
 * Indexes every emitted private and public log under a composite hex-string key
 * `[contractAddress (public only)]-tag-blockNumber-txIndexWithinBlock-logIndexWithinTx`,
 * where each numeric segment is zero-padded to 8 lowercase hex digits (4 bytes BE) and
 * `contractAddress` / `tag` are the bare 64-hex-char field representations (no `0x` prefix). The
 * fixed-width zero-padded hex segments sort lexicographically in the same order as the canonical
 * `(contract, tag, blockNumber, txIndexWithinBlock, logIndexWithinTx)` tuple, so a single ordered
 * range scan answers every {@link PrivateLogsQuery} / {@link PublicLogsQuery}.
 *
 * Per-block secondary indices (`#privateKeysByBlock`, `#publicKeysByBlock`) record the exact primary
 * keys written for each block so {@link deleteLogs} can drop them on reorg without having to range
 * scan by block (block isn't the leading key segment).
 *
 * Contract-class logs are no longer stored or served by the log store.
 */
export class LogStore {
  /** Primary map: composite private key (tag + tail = 96 hex chars + separators) -> serialized {@link StoredLogValue}. */
  #privateLogs: AztecAsyncMap<string, Buffer>;
  /** Primary map: composite public key (contract + tag + tail) -> serialized {@link StoredLogValue}. */
  #publicLogs: AztecAsyncMap<string, Buffer>;

  /** Secondary deletion index: blockNumber -> the exact primary keys written for that block. */
  #privateKeysByBlock: AztecAsyncMap<number, string[]>;
  #publicKeysByBlock: AztecAsyncMap<number, string[]>;

  #log = createLogger('archiver:log_store');

  /**
   * @param genesisBlockHash - Hash of the synthetic genesis block. During early sync the PXE anchors to
   *   genesis and passes its hash as a query `referenceBlock`; since the archiver never indexes the
   *   genesis block, the store recognizes this hash directly and resolves it to the genesis block number
   *   rather than mistaking it for a reorg.
   */
  constructor(
    private db: AztecAsyncKVStore,
    private blockStore: BlockStore,
    private readonly genesisBlockHash: BlockHash,
  ) {
    this.#privateLogs = db.openMap('archiver_private_logs');
    this.#publicLogs = db.openMap('archiver_public_logs');
    this.#privateKeysByBlock = db.openMap('archiver_private_log_keys_by_block');
    this.#publicKeysByBlock = db.openMap('archiver_public_log_keys_by_block');
  }

  /**
   * Indexes every emitted private and public log from the given blocks. Wraps the write in a single
   * `db.transactionAsync` so the primary entries and the per-block secondary indices stay consistent.
   *
   * A block is only ever added once; on reorg the archiver calls {@link deleteLogs} first, so we write
   * the secondary index entries with a plain `set` (overwrite) rather than read-modify-append.
   */
  addLogs(blocks: L2Block[]): Promise<boolean> {
    return this.db.transactionAsync(async () => {
      for (const block of blocks) {
        const blockHash = await block.hash();
        const blockNumber = block.number;
        const blockTimestamp = block.timestamp;

        const privateKeys: string[] = [];
        const privateValues: Buffer[] = [];
        const publicKeys: string[] = [];
        const publicValues: Buffer[] = [];

        for (let txIndexWithinBlock = 0; txIndexWithinBlock < block.body.txEffects.length; txIndexWithinBlock++) {
          const txEffect = block.body.txEffects[txIndexWithinBlock];
          const txHash = txEffect.txHash;

          // Private and public log indices are counted independently per tx, each starting at 0.
          let privateLogIndexWithinTx = 0;
          let publicLogIndexWithinTx = 0;

          for (const log of txEffect.privateLogs) {
            const tagHex = tagHexForLog(log.fields);
            const key = encodeKey(tagHex, blockNumber, txIndexWithinBlock, privateLogIndexWithinTx);
            const value = encodeValue({
              txHash,
              blockHash,
              blockTimestamp,
              logData: log.getEmittedFields(),
            });
            privateKeys.push(key);
            privateValues.push(value);
            privateLogIndexWithinTx++;
          }

          for (const log of txEffect.publicLogs) {
            const contractHex = fieldHex(log.contractAddress);
            const tagHex = tagHexForLog(log.fields);
            const key = encodeKey(
              encodePublicPrefix(contractHex, tagHex),
              blockNumber,
              txIndexWithinBlock,
              publicLogIndexWithinTx,
            );
            const value = encodeValue({
              txHash,
              blockHash,
              blockTimestamp,
              logData: log.getEmittedFields(),
            });
            publicKeys.push(key);
            publicValues.push(value);
            publicLogIndexWithinTx++;
          }
        }

        for (let i = 0; i < privateKeys.length; i++) {
          await this.#privateLogs.set(privateKeys[i], privateValues[i]);
        }
        for (let i = 0; i < publicKeys.length; i++) {
          await this.#publicLogs.set(publicKeys[i], publicValues[i]);
        }

        await this.#privateKeysByBlock.set(blockNumber, privateKeys);
        await this.#publicKeysByBlock.set(blockNumber, publicKeys);

        this.#log.debug(`Indexed logs for block ${blockNumber}`, {
          blockNumber,
          privateCount: privateKeys.length,
          publicCount: publicKeys.length,
        });
      }
      return true;
    });
  }

  /**
   * Deletes every log indexed under any of the given blocks. Secondary-index driven, so it doesn't
   * have to range-scan the primary maps.
   */
  deleteLogs(blocks: L2Block[]): Promise<boolean> {
    return this.db.transactionAsync(async () => {
      for (const block of blocks) {
        const blockNumber = block.number;

        const [privateKeys, publicKeys] = await Promise.all([
          this.#privateKeysByBlock.getAsync(blockNumber),
          this.#publicKeysByBlock.getAsync(blockNumber),
        ]);

        if (privateKeys) {
          for (const key of privateKeys) {
            await this.#privateLogs.delete(key);
          }
          await this.#privateKeysByBlock.delete(blockNumber);
        }
        if (publicKeys) {
          for (const key of publicKeys) {
            await this.#publicLogs.delete(key);
          }
          await this.#publicKeysByBlock.delete(blockNumber);
        }
      }
      return true;
    });
  }

  /** Returns one inner array per element of `query.tags`, in input order. */
  getPrivateLogsByTags(query: ResolvedLogsQuery<PrivateLogsQuery>): Promise<LogResult[][]> {
    LogStore.#validateQuery(query);
    return this.#runQuery(query, /* contractHex */ undefined);
  }

  /** Returns one inner array per element of `query.tags`, in input order. */
  getPublicLogsByTags(query: ResolvedLogsQuery<PublicLogsQuery>): Promise<LogResult[][]> {
    LogStore.#validateQuery(query);
    return this.#runQuery(query, fieldHex(query.contractAddress));
  }

  static #validateQuery(query: { txHash?: TxHash; fromBlock?: unknown; toBlock?: unknown }): void {
    if (query.txHash !== undefined && (query.fromBlock !== undefined || query.toBlock !== undefined)) {
      throw new Error('`txHash` is mutually exclusive with `fromBlock`/`toBlock`');
    }
  }

  async #runQuery(
    query: ResolvedLogsQuery<PrivateLogsQuery> | ResolvedLogsQuery<PublicLogsQuery>,
    contractHex: string | undefined,
  ): Promise<LogResult[][]> {
    const hash = query.referenceBlock;
    if (!hash) {
      // Without an anchor, keep the scans and effect lookups on the same chain so every log has its matching effects.
      if (query.includeEffects === true) {
        return this.db.transactionAsync(() => this.#scanQuery(query, contractHex, query.toBlock));
      }
      return this.#scanQuery(query, contractHex, query.toBlock);
    }
    if (hash.equals(this.genesisBlockHash)) {
      return this.#scanQuery(query, contractHex, Math.min(query.toBlock ?? Infinity, INITIAL_L2_BLOCK_NUM));
    }

    const referenceBlockNumber = await this.#checkReferenceBlock(hash);
    const upperExclusive = Math.min(query.toBlock ?? Infinity, referenceBlockNumber + 1);
    const results = await this.#scanQuery(query, contractHex, upperExclusive);

    // Pruning removes blocks and logs atomically. The anchor fixes the chain within the scan bound,
    // unless the same block was pruned and re-added during the query.
    await this.#checkReferenceBlock(hash, referenceBlockNumber);
    return results;
  }

  async #checkReferenceBlock(hash: BlockHash, expectedNumber?: number): Promise<number> {
    const block = await this.blockStore.getBlockData({ hash });
    const number = block?.header.globalVariables.blockNumber;
    // getBlockData reads the hash index and block metadata separately, so the height alone is not enough.
    if (
      !block ||
      number === undefined ||
      !block.blockHash.equals(hash) ||
      (expectedNumber !== undefined && number !== expectedNumber)
    ) {
      throw new Error(
        `Reference block ${hash.toString()} not found in the node. This might indicate a reorg has occurred.`,
      );
    }
    return number;
  }

  async #scanQuery(
    query: ResolvedLogsQuery<PrivateLogsQuery> | ResolvedLogsQuery<PublicLogsQuery>,
    contractHex: string | undefined,
    upperExclusive: number | undefined,
  ): Promise<LogResult[][]> {
    const tags: TagQuery<Tag | SiloedTag>[] = query.tags ?? [];
    const primaryMap = contractHex !== undefined ? this.#publicLogs : this.#privateLogs;

    // Resolve txHash -> (blockNumber, txIndexInBlock) once for the whole query.
    let txLocation: [number, number] | undefined;
    if (query.txHash) {
      const loc = await this.blockStore.getTxLocation(query.txHash);
      if (!loc) {
        return tags.map(() => []);
      }
      txLocation = [loc.blockNumber, loc.txIndexInBlock];
      if (upperExclusive !== undefined && txLocation[0] >= upperExclusive) {
        return tags.map(() => []);
      }
    }

    const fromBlock = query.fromBlock ?? INITIAL_L2_BLOCK_NUM;
    const includeEffects = query.includeEffects === true;

    const perTagResults = await asyncPool(TAG_SCAN_CONCURRENCY, tags, async tagEntry => {
      const { tagHex, afterLog } = normalizeTagEntry(tagEntry);
      const prefix = contractHex !== undefined ? encodePublicPrefix(contractHex, tagHex) : tagHex;

      const end = txLocation
        ? endOfTxRange(prefix, txLocation[0], txLocation[1])
        : endOfTagRange(prefix, upperExclusive);

      let start: string;
      if (afterLog) {
        // Cursor wins as the start; `fromBlock` is ignored (fine if the cursor sits below it). The cursor
        // carries `(blockNumber, txIndexWithinBlock, logIndexWithinTx)`, which slot directly into the
        // composite key — no tx-hash lookup needed.
        start = incKey(encodeKey(prefix, afterLog.blockNumber, afterLog.txIndexWithinBlock, afterLog.logIndexWithinTx));
      } else if (txLocation) {
        start = encodeKey(prefix, txLocation[0], txLocation[1], 0);
      } else {
        start = encodeKey(prefix, fromBlock, 0, 0);
      }

      const limit = query.limitPerTag ?? MAX_LOGS_PER_TAG;
      const out: LogResult[] = [];
      for await (const [rawKey, rawVal] of primaryMap.entriesAsync({ start, end, limit })) {
        const tail = decodeKeyTail(rawKey);
        const value = decodeValue(rawVal);
        // A reorg can replace the transaction at the resolved position before the cursor opens.
        if (query.txHash && !value.txHash.equals(query.txHash)) {
          continue;
        }
        out.push({
          logData: value.logData,
          blockNumber: tail.blockNumber,
          blockHash: value.blockHash,
          blockTimestamp: value.blockTimestamp,
          txHash: value.txHash,
          txIndexWithinBlock: tail.txIndexWithinBlock,
          logIndexWithinTx: tail.logIndexWithinTx,
        });
      }
      return out;
    });

    if (includeEffects) {
      // Dedupe by txHash across the entire page so a tx with many tagged logs costs one fetch.
      const txHashByKey = new Map<string, TxHash>();
      for (const arr of perTagResults) {
        for (const log of arr) {
          txHashByKey.set(log.txHash.toString(), log.txHash);
        }
      }
      const uniqueTxs = Array.from(txHashByKey.values());
      if (uniqueTxs.length > 0) {
        const effects = await this.blockStore.getNoteHashesAndNullifiers(uniqueTxs);
        const byTxHash = new Map<string, [Fr[], Fr[]]>();
        uniqueTxs.forEach((tx, i) => byTxHash.set(tx.toString(), effects[i]));
        for (let i = 0; i < perTagResults.length; i++) {
          perTagResults[i] = perTagResults[i].map(log => {
            const [noteHashes, nullifiers] = byTxHash.get(log.txHash.toString()) ?? [[], []];
            return { ...log, noteHashes, nullifiers };
          });
        }
      }
    }

    return perTagResults;
  }

  /**
   * Reads back every private log indexed for the given block via the per-block secondary index. Order
   * matches the canonical composite-key order (`tag`, `blockNumber`, `txIndexWithinBlock`,
   * `logIndexWithinTx`). Used by the data-store-updater test suite to verify the indexed-vs-block-body
   * counts without depending on the removed `getPublicLogs(LogFilter)` API.
   */
  getPrivateLogsForBlock(blockNumber: number): Promise<LogResult[]> {
    return this.#readBlockLogs(this.#privateKeysByBlock, this.#privateLogs, blockNumber);
  }

  /** {@inheritDoc LogStore.getPrivateLogsForBlock} */
  getPublicLogsForBlock(blockNumber: number): Promise<LogResult[]> {
    return this.#readBlockLogs(this.#publicKeysByBlock, this.#publicLogs, blockNumber);
  }

  async #readBlockLogs(
    keysByBlock: AztecAsyncMap<number, string[]>,
    primaryMap: AztecAsyncMap<string, Buffer>,
    blockNumber: number,
  ): Promise<LogResult[]> {
    // Hold the writer queue so a replacement block cannot reuse primary keys from the old block's index.
    return this.db.transactionAsync(async () => {
      const keys = await keysByBlock.getAsync(blockNumber);
      if (!keys || keys.length === 0) {
        return [];
      }
      const results: LogResult[] = [];
      for (const key of keys) {
        const raw = await primaryMap.getAsync(key);
        if (!raw) {
          continue;
        }
        const tail = decodeKeyTail(key);
        const value = decodeValue(raw);
        results.push({
          logData: value.logData,
          blockNumber: tail.blockNumber,
          blockHash: value.blockHash,
          blockTimestamp: value.blockTimestamp,
          txHash: value.txHash,
          txIndexWithinBlock: tail.txIndexWithinBlock,
          logIndexWithinTx: tail.logIndexWithinTx,
        });
      }
      return results;
    });
  }
}

/** Pulls `{ tagHex, afterLog }` out of a {@link TagQuery}, normalizing the bare-tag form. */
function normalizeTagEntry<T extends Tag | SiloedTag>(
  entry: TagQuery<T>,
): {
  tagHex: string;
  afterLog: LogCursor | undefined;
} {
  if (typeof entry === 'object' && entry !== null && 'tag' in entry) {
    return { tagHex: fieldHex(entry.tag.value), afterLog: entry.afterLog };
  }
  return { tagHex: fieldHex((entry as T).value), afterLog: undefined };
}
