/**
 * LMDB implementation of SlashingProtectionDatabase
 *
 * Provides local (single-node) double-signing protection using LMDB as the backend.
 * Suitable for nodes that do NOT run in a high-availability multi-node setup.
 *
 * The LMDB store is single-writer, making setIfNotExists inherently atomic.
 * This means we get crash-restart protection without needing an external database.
 */
import { SlotNumber } from '@aztec-labs/foundation/branded-types';
import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import type { DateProvider } from '@aztec-labs/foundation/timer';
import type { AztecAsyncKVStore, AztecAsyncMap } from '@aztec-labs/kv-store';
import { openStoreAt } from '@aztec-labs/kv-store/lmdb-v2';

import type { SlashingProtectionDatabase, TryInsertOrGetResult } from '../types.js';
import {
  type CheckAndRecordParams,
  DutyStatus,
  DutyType,
  type StoredDutyRecord,
  getBlockIndexFromDutyIdentifier,
  recordFromFields,
} from './types.js';

const DUTIES_MAP_NAME = 'signing-protection-duties';
const LEGACY_CHECKPOINT_NUMBER = '0';

type StoredDutyRecordV1 = Omit<StoredDutyRecord, 'checkpointNumber'> & { checkpointNumber?: undefined };
type MigratableStoredDutyRecord = StoredDutyRecord | StoredDutyRecordV1;

/**
 * Migrates local slashing-protection duties to the current schema, retaining legacy records for 30 days.
 */
export async function migrateLmdbSlashingProtectionDatabase(
  dataDirectory: string,
  currentVersion: number,
  latestVersion: number,
  dbMapSizeKb?: number,
): Promise<void> {
  if (![1, 2].includes(currentVersion) || latestVersion !== LmdbSlashingProtectionDatabase.SCHEMA_VERSION) {
    throw new Error(`Unsupported LMDB slashing-protection migration ${currentVersion} -> ${latestVersion}`);
  }

  const store = await openStoreAt(dataDirectory, dbMapSizeKb);
  try {
    const duties = store.openMap<string, MigratableStoredDutyRecord>(DUTIES_MAP_NAME);
    const migratedRecords: { key: string; value: StoredDutyRecord }[] = [];

    const expiresAtMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    for await (const [key, record] of duties.entriesAsync()) {
      migratedRecords.push({
        key,
        value: {
          ...record,
          checkpointNumber: record.checkpointNumber ?? LEGACY_CHECKPOINT_NUMBER,
          expiresAtMs: record.expiresAtMs ?? expiresAtMs,
        },
      });
    }

    if (migratedRecords.length > 0) {
      await duties.setMany(migratedRecords);
    }
  } finally {
    await store.close();
  }
}

function dutyKey(
  rollupAddress: string,
  validatorAddress: string,
  slot: string,
  dutyType: string,
  blockIndexWithinCheckpoint: number,
): string {
  return `${rollupAddress}:${validatorAddress}:${slot}:${dutyType}:${blockIndexWithinCheckpoint}`;
}

/**
 * LMDB-backed implementation of SlashingProtectionDatabase.
 *
 * Provides single-node double-signing protection that survives crashes and restarts.
 * Does not provide cross-node coordination (that requires the PostgreSQL implementation).
 */
export class LmdbSlashingProtectionDatabase implements SlashingProtectionDatabase {
  public static readonly SCHEMA_VERSION = 3;

  private readonly duties: AztecAsyncMap<string, StoredDutyRecord>;
  private readonly log: Logger;

  constructor(
    private readonly store: AztecAsyncKVStore,
    private readonly dateProvider: DateProvider,
  ) {
    this.log = createLogger('slashing-protection:lmdb');
    this.duties = store.openMap<string, StoredDutyRecord>(DUTIES_MAP_NAME);
  }

  /**
   * Atomically try to insert a new duty record, or get the existing one if present.
   *
   * LMDB is single-writer so the read-then-write inside transactionAsync is naturally atomic.
   */
  public async tryInsertOrGetExisting(params: CheckAndRecordParams): Promise<TryInsertOrGetResult> {
    const blockIndexWithinCheckpoint = getBlockIndexFromDutyIdentifier(params);
    const key = dutyKey(
      params.rollupAddress.toString(),
      params.validatorAddress.toString(),
      params.slot.toString(),
      params.dutyType,
      blockIndexWithinCheckpoint,
    );

    const lockToken = randomBytes(16).toString('hex');
    const now = this.dateProvider.now();

    const result = await this.store.transactionAsync(async () => {
      const existing = await this.duties.getAsync(key);
      if (existing) {
        return { isNew: false as const, record: { ...existing, lockToken: '' } };
      }

      const newRecord: StoredDutyRecord = {
        rollupAddress: params.rollupAddress.toString(),
        validatorAddress: params.validatorAddress.toString(),
        slot: params.slot.toString(),
        blockNumber: params.blockNumber.toString(),
        checkpointNumber: params.checkpointNumber.toString(),
        blockIndexWithinCheckpoint,
        dutyType: params.dutyType,
        status: DutyStatus.SIGNING,
        messageHash: params.messageHash,
        nodeId: params.nodeId,
        lockToken,
        startedAtMs: now,
        expiresAtMs: params.retentionMs === undefined ? undefined : now + params.retentionMs,
      };
      await this.duties.set(key, newRecord);
      return { isNew: true as const, record: newRecord };
    });

    if (result.isNew) {
      this.log.debug(`Acquired lock for duty ${params.dutyType} at slot ${params.slot}`, {
        validatorAddress: params.validatorAddress.toString(),
        nodeId: params.nodeId,
      });
    }

    return { isNew: result.isNew, record: recordFromFields(result.record) };
  }

  /**
   * Update a duty to 'signed' status with the signature.
   * Only succeeds if the lockToken matches.
   */
  public updateDutySigned(
    rollupAddress: EthAddress,
    validatorAddress: EthAddress,
    slot: SlotNumber,
    dutyType: DutyType,
    signature: string,
    lockToken: string,
    blockIndexWithinCheckpoint: number,
  ): Promise<boolean> {
    const key = dutyKey(
      rollupAddress.toString(),
      validatorAddress.toString(),
      slot.toString(),
      dutyType,
      blockIndexWithinCheckpoint,
    );

    return this.store.transactionAsync(async () => {
      const existing = await this.duties.getAsync(key);
      if (!existing) {
        this.log.warn('Failed to update duty to signed: duty not found', {
          rollupAddress: rollupAddress.toString(),
          validatorAddress: validatorAddress.toString(),
          slot: slot.toString(),
          dutyType,
          blockIndexWithinCheckpoint,
        });
        return false;
      }

      if (existing.lockToken !== lockToken) {
        this.log.warn('Failed to update duty to signed: invalid token', {
          rollupAddress: rollupAddress.toString(),
          validatorAddress: validatorAddress.toString(),
          slot: slot.toString(),
          dutyType,
          blockIndexWithinCheckpoint,
        });
        return false;
      }

      await this.duties.set(key, {
        ...existing,
        status: DutyStatus.SIGNED,
        signature,
        completedAtMs: this.dateProvider.now(),
      });

      return true;
    });
  }

  /**
   * Delete a duty record.
   * Only succeeds if the lockToken matches.
   */
  public deleteDuty(
    rollupAddress: EthAddress,
    validatorAddress: EthAddress,
    slot: SlotNumber,
    dutyType: DutyType,
    lockToken: string,
    blockIndexWithinCheckpoint: number,
  ): Promise<boolean> {
    const key = dutyKey(
      rollupAddress.toString(),
      validatorAddress.toString(),
      slot.toString(),
      dutyType,
      blockIndexWithinCheckpoint,
    );

    return this.store.transactionAsync(async () => {
      const existing = await this.duties.getAsync(key);
      if (!existing || existing.lockToken !== lockToken) {
        this.log.warn('Failed to delete duty: invalid token or duty not found', {
          rollupAddress: rollupAddress.toString(),
          validatorAddress: validatorAddress.toString(),
          slot: slot.toString(),
          dutyType,
          blockIndexWithinCheckpoint,
        });
        return false;
      }

      await this.duties.delete(key);
      return true;
    });
  }

  /**
   * Cleanup own stuck duties (SIGNING status older than maxAgeMs).
   */
  public cleanupOwnStuckDuties(nodeId: string, maxAgeMs: number): Promise<number> {
    const cutoffMs = this.dateProvider.now() - maxAgeMs;

    return this.store.transactionAsync(async () => {
      const keysToDelete: string[] = [];
      for await (const [key, record] of this.duties.entriesAsync()) {
        if (record.nodeId === nodeId && record.status === DutyStatus.SIGNING && record.startedAtMs < cutoffMs) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        await this.duties.delete(key);
      }
      return keysToDelete.length;
    });
  }

  /**
   * Cleanup expired duties across all rollups using their persisted deadlines.
   */
  public cleanupOldDuties(): Promise<number> {
    const now = this.dateProvider.now();

    return this.store.transactionAsync(async () => {
      const keysToDelete: string[] = [];
      for await (const [key, record] of this.duties.entriesAsync()) {
        if (record.expiresAtMs !== undefined && record.expiresAtMs <= now) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        await this.duties.delete(key);
      }
      return keysToDelete.length;
    });
  }

  /**
   * Close the underlying LMDB store.
   */
  public async close(): Promise<void> {
    await this.store.close();
    this.log.debug('LMDB slashing protection database closed');
  }
}
