import type {
  BlockNumber,
  CheckpointNumber,
  IndexWithinCheckpoint,
  SlotNumber,
} from '@aztec-labs/foundation/branded-types';
import type { BlockHash } from '@aztec-labs/stdlib/block';
import type { InboxMessagePrefixRef } from '@aztec-labs/stdlib/messaging';
import type { SubslotSelection } from '@aztec-labs/stdlib/timetable';

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

/**
 * The scheduling view of the checkpoint being built, so a hook that holds the job can ask the proposer's own
 * timetable what is still possible at the moment it wants to release, rather than re-deriving sub-slot arithmetic
 * from the deadlines in the event. Every method takes wall-clock seconds, matching {@link ProposerTimetable}.
 */
export type CheckpointProposalJobSchedule = {
  /** The sub-slot the proposer would start next at `nowSeconds`, or `canStart: false` when none is left. */
  selectNextSubslot(nowSeconds: number): SubslotSelection;
  /** Hard consensus deadline by which a proposal for this slot must have arrived at a validator. */
  getProposalReceiveDeadlineSeconds(): number;
  /** Earliest instant at which a proposal for this slot is acceptable on ingress. */
  getProposalReceiveStartSeconds(): number;
  /** Cutoff by which every block and the checkpoint must be re-executed, validated and signed. */
  getAttestationDeadlineSeconds(): number;
};

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
  /**
   * Block sub-slots the timetable had left for this checkpoint at the instant the block was built. A snapshot: a
   * hook that holds the job spends the slot's real budget, so ask {@link schedule} rather than this number when
   * deciding whether another block can still be built after a hold.
   */
  remainingBuildSubslots: number;
  /** Wall-clock instant by which the checkpoint proposal has to be on the wire for validators to receive it in time. */
  proposalSendDeadline: Date;
  /** Cumulative Inbox message count the chain has consumed through this block. */
  consumedMessageCount: bigint;
  /** The prefix reference this block signed over. */
  inboxPrefixRef: InboxMessagePrefixRef;
  /** The proposer's own timetable, bound to this checkpoint's target slot. */
  schedule: CheckpointProposalJobSchedule;
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
