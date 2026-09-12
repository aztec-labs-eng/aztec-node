import type {
  BlockNumber,
  CheckpointNumber,
  IndexWithinCheckpoint,
  SlotNumber,
} from '@aztec-labs/foundation/branded-types';
import type { BlockHash } from '@aztec-labs/stdlib/block';
import type { InboxMessagePrefixRef } from '@aztec-labs/stdlib/messaging';

/**
 * A point inside a checkpoint build at which a test may take control.
 *
 * `block-ready-to-broadcast` fires once a block has been signed and durably stored by the proposer's own archiver,
 * and before that block is gossiped or the next sub-slot selects and freezes its Inbox range. At that instant the
 * block exists as committed local state, its parent is still available for a peer to re-execute against, and no
 * later block has yet committed to a message prefix — the only barrier from which a test can change L1 and know
 * exactly which side of the change each block falls on.
 */
export type CheckpointProposalJobTestPhase = 'block-ready-to-broadcast';

/** The state of a checkpoint build at a {@link CheckpointProposalJobTestPhase}, handed to the test hook. */
export type CheckpointProposalJobTestEvent = {
  phase: CheckpointProposalJobTestPhase;
  /** Slot the checkpoint is being proposed for (the target slot, not the wall-clock build slot). */
  slot: SlotNumber;
  checkpointNumber: CheckpointNumber;
  blockNumber: BlockNumber;
  indexWithinCheckpoint: IndexWithinCheckpoint;
  blockHash: BlockHash;
  /** Whether this block is gossiped on its own; the checkpoint's final block travels with the checkpoint instead. */
  isStandalone: boolean;
  /** Block sub-slots the timetable still has left for this checkpoint after the one that built this block. */
  remainingBuildSubslots: number;
  /** Wall-clock instant by which the checkpoint proposal has to be on the wire for validators to receive it in time. */
  proposalSendDeadline: Date;
  /** Cumulative Inbox message count the chain has consumed through this block. */
  consumedMessageCount: bigint;
  /** The prefix reference this block signed over. */
  inboxPrefixRef: InboxMessagePrefixRef;
};

/**
 * Optional in-process hooks a test may inject into checkpoint building to order real chain operations against block
 * production. Dependency-injected through the node factory and never part of the serialized node configuration, so
 * they are unreachable over RPC and absent from every production path that does not pass them.
 *
 * A hook is awaited inline by the proposal job, so it holds a live proposer with a real deadline: whatever it does
 * spends that slot's remaining budget.
 */
export type CheckpointProposalJobTestHooks = {
  onCheckpointPhase?: (event: CheckpointProposalJobTestEvent) => Promise<void>;
};
