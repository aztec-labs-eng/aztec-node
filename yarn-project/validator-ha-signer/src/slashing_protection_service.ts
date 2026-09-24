/**
 * Slashing Protection Service
 *
 * Provides distributed locking and slashing protection for validator duties.
 * Uses an external database to coordinate across multiple validator nodes.
 */
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/promise';
import { sleep } from '@aztec-labs/foundation/sleep';
import type { DateProvider } from '@aztec-labs/foundation/timer';
import type { BaseSignerConfig } from '@aztec-labs/stdlib/ha-signing';

import {
  type CheckAndRecordParams,
  type DeleteDutyParams,
  DutyStatus,
  type RecordSuccessParams,
  getBlockIndexFromDutyIdentifier,
} from './db/types.js';
import { DutyAlreadySignedError, SlashingProtectionError } from './errors.js';
import type { HASignerMetrics } from './metrics.js';
import type { SlashingProtectionDatabase } from './types.js';

export interface SlashingProtectionServiceDeps {
  metrics: HASignerMetrics;
  dateProvider: DateProvider;
}

/** Default max age (ms) of a stuck SIGNING duty before cleanup reclaims it: 2x the 72s Aztec slot duration. */
export const DEFAULT_MAX_STUCK_DUTIES_AGE_MS = 144_000;

/**
 * Slashing Protection Service
 *
 * This service ensures that a validator only signs one block/attestation per slot,
 * even when running multiple redundant nodes (HA setup).
 *
 * All nodes in the HA setup try to sign - the first one wins, others get
 * DutyAlreadySignedError (normal) or SlashingProtectionError (if different data).
 *
 * Flow:
 * 1. checkAndRecord() - Atomically try to acquire lock via tryInsertOrGetExisting
 * 2. Caller performs the signing operation
 * 3. recordSuccess() - Update to 'signed' status with signature
 *    OR deleteDuty() - Delete the record to allow retry
 */
export class SlashingProtectionService {
  private readonly log: Logger;
  private readonly pollingIntervalMs: number;
  private readonly peerSigningTimeoutMs: number;
  private readonly maxStuckDutiesAgeMs: number;

  private readonly metrics: HASignerMetrics;
  private readonly dateProvider: DateProvider;

  private cleanupRunningPromise: RunningPromise;
  private lastOldDutiesCleanupAtMs?: number;

  constructor(
    private readonly db: SlashingProtectionDatabase,
    private readonly config: BaseSignerConfig,
    deps: SlashingProtectionServiceDeps,
  ) {
    this.log = createLogger('slashing-protection');
    this.pollingIntervalMs = config.pollingIntervalMs;
    this.peerSigningTimeoutMs = config.peerSigningTimeoutMs;
    this.maxStuckDutiesAgeMs = config.maxStuckDutiesAgeMs ?? DEFAULT_MAX_STUCK_DUTIES_AGE_MS;

    this.cleanupRunningPromise = new RunningPromise(this.cleanup.bind(this), this.log, this.maxStuckDutiesAgeMs);
    this.metrics = deps.metrics;
    this.dateProvider = deps.dateProvider;
  }

  /**
   * Check if a duty can be performed and acquire the lock if so.
   *
   * This method uses an atomic insert-or-get operation.
   * It will:
   * 1. Try to insert a new record with 'signing' status
   * 2. If insert succeeds, we acquired the lock - return the lockToken
   * 3. If a record exists, handle based on status:
   *    - SIGNED: Throw appropriate error (already signed or slashing protection)
   *    - SIGNING: Wait and poll until status changes, then handle result
   *
   * @returns The lockToken that must be used for recordSuccess/deleteDuty
   * @throws DutyAlreadySignedError if the duty was already completed
   * @throws SlashingProtectionError if attempting to sign different data for same slot/duty
   */
  async checkAndRecord(params: CheckAndRecordParams): Promise<string> {
    const { validatorAddress, slot, dutyType, messageHash, nodeId } = params;
    const startTime = this.dateProvider.now();

    this.log.debug(`Checking duty: ${dutyType} for slot ${slot}`, {
      validatorAddress: validatorAddress.toString(),
      nodeId,
    });

    while (true) {
      // insert if not present, get existing if present
      const { isNew, record } = await this.db.tryInsertOrGetExisting({
        ...params,
        retentionMs:
          this.config.cleanupOldDutiesAfterHours === undefined
            ? undefined
            : this.config.cleanupOldDutiesAfterHours * 60 * 60 * 1000,
      });

      if (isNew) {
        // We successfully acquired the lock
        this.log.verbose(`Acquired lock for duty ${dutyType} at slot ${slot}`, {
          validatorAddress: validatorAddress.toString(),
          nodeId,
        });
        this.metrics.recordLockAcquire(true);
        return record.lockToken;
      }

      // Record already exists - handle based on status
      if (record.status === DutyStatus.SIGNED) {
        // Duty was already signed - check if same or different data
        if (record.messageHash !== messageHash) {
          this.log.verbose(`Slashing protection triggered for duty ${dutyType} at slot ${slot}`, {
            validatorAddress: validatorAddress.toString(),
            existingMessageHash: record.messageHash,
            attemptedMessageHash: messageHash,
            existingNodeId: record.nodeId,
            attemptingNodeId: nodeId,
          });
          this.metrics.recordSlashingProtection(dutyType);
          throw new SlashingProtectionError(
            slot,
            dutyType,
            record.blockIndexWithinCheckpoint,
            record.messageHash,
            messageHash,
            record.nodeId,
          );
        }
        this.metrics.recordDutyAlreadySigned(dutyType);
        throw new DutyAlreadySignedError(slot, dutyType, record.blockIndexWithinCheckpoint, record.nodeId);
      } else if (record.status === DutyStatus.SIGNING) {
        // Another node is currently signing - check for timeout
        if (this.dateProvider.now() - startTime > this.peerSigningTimeoutMs) {
          this.log.warn(`Timeout waiting for signing to complete for duty ${dutyType} at slot ${slot}`, {
            validatorAddress: validatorAddress.toString(),
            timeoutMs: this.peerSigningTimeoutMs,
            signingNodeId: record.nodeId,
          });
          this.metrics.recordDutyAlreadySigned(dutyType);
          throw new DutyAlreadySignedError(slot, dutyType, record.blockIndexWithinCheckpoint, 'unknown (timeout)');
        }

        // Wait and poll
        this.log.debug(`Waiting for signing to complete for duty ${dutyType} at slot ${slot}`, {
          validatorAddress: validatorAddress.toString(),
          signingNodeId: record.nodeId,
        });
        await sleep(this.pollingIntervalMs);
        // Loop continues - next iteration will check status again
      } else {
        throw new Error(`Unknown duty status: ${record.status}`);
      }
    }
  }

  /**
   * Record a successful signing operation.
   * Updates the duty status to 'signed' and stores the signature.
   * Only succeeds if the lockToken matches (caller must be the one who created the duty).
   *
   * @returns true if the update succeeded, false if token didn't match
   */
  async recordSuccess(params: RecordSuccessParams): Promise<boolean> {
    const { rollupAddress, validatorAddress, slot, dutyType, signature, nodeId, lockToken } = params;
    const blockIndexWithinCheckpoint = getBlockIndexFromDutyIdentifier(params);

    const success = await this.db.updateDutySigned(
      rollupAddress,
      validatorAddress,
      slot,
      dutyType,
      signature.toString(),
      lockToken,
      blockIndexWithinCheckpoint,
    );

    if (success) {
      this.log.verbose(`Recorded successful signing for duty ${dutyType} at slot ${slot}`, {
        validatorAddress: validatorAddress.toString(),
        nodeId,
      });
    } else {
      this.log.warn(`Failed to record successful signing for duty ${dutyType} at slot ${slot}: invalid token`, {
        validatorAddress: validatorAddress.toString(),
        nodeId,
      });
    }

    return success;
  }

  /**
   * Delete a duty record after a failed signing operation.
   * Removes the record to allow another node/attempt to retry.
   * Only succeeds if the lockToken matches (caller must be the one who created the duty).
   *
   * @returns true if the delete succeeded, false if token didn't match
   */
  async deleteDuty(params: DeleteDutyParams): Promise<boolean> {
    const { rollupAddress, validatorAddress, slot, dutyType, lockToken } = params;
    const blockIndexWithinCheckpoint = getBlockIndexFromDutyIdentifier(params);

    const success = await this.db.deleteDuty(
      rollupAddress,
      validatorAddress,
      slot,
      dutyType,
      lockToken,
      blockIndexWithinCheckpoint,
    );

    if (success) {
      this.log.info(`Deleted duty ${dutyType} at slot ${slot} to allow retry`, {
        validatorAddress: validatorAddress.toString(),
      });
    } else {
      this.log.warn(`Failed to delete duty ${dutyType} at slot ${slot}: invalid token`, {
        validatorAddress: validatorAddress.toString(),
      });
    }

    return success;
  }

  /**
   * Get the node ID for this service
   */
  get nodeId(): string {
    return this.config.nodeId;
  }

  /**
   * Start running tasks.
   * Cleanup runs immediately on start to recover from any previous crashes.
   */
  /**
   * Start the background cleanup task.
   */
  start(): Promise<void> {
    // Other replicas may still serve a different rollup, whose signing history must survive our startup.
    this.cleanupRunningPromise.start();
    this.log.info('Slashing protection service started', { nodeId: this.config.nodeId });
    return Promise.resolve();
  }

  /**
   * Stop the background cleanup task.
   */
  async stop() {
    await this.cleanupRunningPromise.stop();
    this.log.info('Slashing protection service stopped', { nodeId: this.config.nodeId });
  }

  /**
   * Close the database connection.
   * Should be called after stop() during graceful shutdown.
   */
  async close() {
    await this.db.close();
    this.log.info('Slashing protection database connection closed');
  }

  /**
   * Periodic cleanup of stuck duties and expired records across all rollups.
   * Runs in the background via RunningPromise.
   */
  private async cleanup() {
    // 1. Clean up stuck duties (our own node's duties that got stuck in 'signing' status).
    // This cannot race an in-flight signing: every signing operation is hard-bounded by a timeout
    // clamped below maxStuckDutiesAgeMs / 2 (see ValidatorHASigner), so a live SIGNING row is
    // always released long before it can be considered stuck.
    const numStuckDuties = await this.db.cleanupOwnStuckDuties(this.config.nodeId, this.maxStuckDutiesAgeMs);
    if (numStuckDuties > 0) {
      this.log.verbose(`Cleaned up ${numStuckDuties} stuck duties`, {
        nodeId: this.config.nodeId,
        maxStuckDutiesAgeMs: this.maxStuckDutiesAgeMs,
      });
      this.metrics.recordCleanup('stuck', numStuckDuties);
    }

    // Expired records from retired rollups must be collected even when this node retains its own duties indefinitely.
    const nowMs = this.dateProvider.now();
    if (this.lastOldDutiesCleanupAtMs === undefined || nowMs - this.lastOldDutiesCleanupAtMs >= 60 * 60 * 1000) {
      const numOldDuties = await this.db.cleanupOldDuties();
      this.lastOldDutiesCleanupAtMs = nowMs;
      if (numOldDuties > 0) {
        this.log.verbose(`Cleaned up ${numOldDuties} expired duties`);
        this.metrics.recordCleanup('old', numOldDuties);
      }
    }
  }
}
