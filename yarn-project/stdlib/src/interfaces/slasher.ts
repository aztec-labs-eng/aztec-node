import type { SlotNumber } from '@aztec-labs/foundation/branded-types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { schemas, zodFor } from '@aztec-labs/foundation/schemas';
import { z } from 'zod';

import type { Offense, ProposerSlashAction } from '../slashing/index.js';

/** Common interface for slasher clients used by the Aztec node. */
export interface SlasherClientInterface {
  /** Start the slasher client */
  start(): Promise<void>;

  /** Stop the slasher client */
  stop(): Promise<void>;

  /** Gather offenses for a given round, defaults to current. */
  gatherOffensesForRound(round?: bigint): Promise<Offense[]>;

  /** Returns all offenses */
  getOffenses(): Promise<Offense[]>;

  /** Update the configuration. */
  updateConfig(config: Partial<SlasherConfig>): void;

  /**
   * Get the actions the proposer should take for slashing.
   * @param slotNumber - The current slot number
   * @returns The actions to take
   */
  getProposerActions(slotNumber: SlotNumber): Promise<ProposerSlashAction[]>;

  /** Returns the current config */
  getConfig(): SlasherConfig;
}

export interface SlasherConfig {
  slashOverridePayload?: EthAddress;
  slashSelfAllowed?: boolean; // Whether to allow slashes to own validators
  slashValidatorsAlways: EthAddress[]; // Array of validator addresses
  slashValidatorsNever: EthAddress[]; // Array of validator addresses
  slashInactivityTargetPercentage: number; // 0-1, 0.9 means 90%. Must be greater than 0
  slashInactivityConsecutiveEpochThreshold: number; // Number of consecutive epochs a validator must be inactive before slashing
  slashDataWithholdingPenalty: bigint;
  /**
   * Number of full L2 slots that must elapse after a checkpoint's slot before declaring its
   * txs missing and slashing the checkpoint's attesters for data withholding. With tolerance
   * = N and checkpoint slot S, the check fires at the start of slot `S + N + 1`.
   */
  slashDataWithholdingToleranceSlots: number;
  slashInactivityPenalty: bigint;
  slashBroadcastedInvalidBlockPenalty: bigint;
  slashBroadcastedInvalidCheckpointProposalPenalty: bigint;
  slashDuplicateProposalPenalty: bigint;
  slashDuplicateAttestationPenalty: bigint;
  slashProposeInvalidAttestationsPenalty: bigint;
  slashProposeDescendantOfCheckpointWithInvalidAttestationsPenalty: bigint;
  slashAttestInvalidCheckpointProposalPenalty: bigint;
  slashUnknownPenalty: bigint;
  slashOffenseExpirationRounds: number; // Number of rounds after which pending offenses expire
  slashMaxPayloadSize: number; // Maximum number of offenses to include in a single slash payload
  slashGracePeriodL2Slots: number; // Number of L2 slots to wait after genesis before slashing for most offenses
  slashExecuteRoundsLookBack: number; // How many rounds to look back when searching for a round to execute
}

export const SlasherConfigSchema = zodFor<SlasherConfig>()(
  z.object({
    slashOverridePayload: schemas.EthAddress.optional(),
    slashValidatorsAlways: z.array(schemas.EthAddress),
    slashValidatorsNever: z.array(schemas.EthAddress),
    slashDataWithholdingPenalty: schemas.BigInt,
    // Tolerated as undefined to allow validating responses from older node images that
    // predate the per-slot data-withholding watcher (PR #23116).
    slashDataWithholdingToleranceSlots: z.number().default(3),
    slashInactivityTargetPercentage: z.number(),
    slashInactivityConsecutiveEpochThreshold: z.number(),
    slashInactivityPenalty: schemas.BigInt,
    slashProposeInvalidAttestationsPenalty: schemas.BigInt,
    // Tolerated as undefined to allow validating responses from older node images that
    // predate this slasher penalty being added.
    slashBroadcastedInvalidCheckpointProposalPenalty: schemas.BigInt.default(0n),
    slashDuplicateProposalPenalty: schemas.BigInt,
    slashDuplicateAttestationPenalty: schemas.BigInt,
    slashProposeDescendantOfCheckpointWithInvalidAttestationsPenalty: schemas.BigInt,
    slashAttestInvalidCheckpointProposalPenalty: schemas.BigInt,
    slashUnknownPenalty: schemas.BigInt,
    slashOffenseExpirationRounds: z.number(),
    slashMaxPayloadSize: z.number(),
    slashGracePeriodL2Slots: z.number(),
    slashBroadcastedInvalidBlockPenalty: schemas.BigInt,
    slashExecuteRoundsLookBack: z.number(),
    slashSelfAllowed: z.boolean().optional(),
  }),
);
