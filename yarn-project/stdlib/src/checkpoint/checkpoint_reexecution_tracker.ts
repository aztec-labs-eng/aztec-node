import type { CheckpointNumber, CheckpointProposalHash, SlotNumber } from '@aztec-labs/foundation/branded-types';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';

import type { TxHash } from '../tx/tx_hash.js';

/**
 * Outcome of attempting to re-execute a checkpoint proposal locally.
 *
 * - `valid`        — re-execution succeeded and the computed checkpoint matched the proposal.
 * - `invalid`      — the proposal disagreed with the computed checkpoint, or violated a deterministic
 *                    constraint (limits, signatures, etc).
 * - `unvalidated`  — the local node could not complete validation for non-deterministic reasons
 *                    (missing blocks/txs, timeouts, infra errors). Treated as proposer-fault for
 *                    slashing but surfaced separately for telemetry.
 */
export type ReexecutionOutcome = 'valid' | 'invalid' | 'unvalidated';

/** What the tracker recorded about the checkpoint proposal evaluated for a slot. */
export type ReexecutionRecord = {
  outcome: ReexecutionOutcome;
  checkpointNumber?: CheckpointNumber;
  /** Archive root in the evaluated proposal. */
  archiveRoot?: string;
  /** Archive root of the parent checkpoint the proposal builds on, when known. */
  lastArchiveRoot?: string;
  /** Hash of the evaluated proposal's signed payload, which its attestations sign. */
  payloadHash?: CheckpointProposalHash;
};

/** Optional details of an evaluated checkpoint proposal, beyond what identifies it. */
export type ReexecutionDetails = {
  /** Archive root of the parent checkpoint the proposal builds on (the checkpoint header's `lastArchiveRoot`). */
  lastArchiveRoot?: Fr;
  /** Hash of the proposal's signed payload. */
  payloadHash?: CheckpointProposalHash;
};

/**
 * Tracks two pieces of per-slot state collected during proposal handling:
 *
 *  1. The txs this node held at proposal time, from block proposals whose txs were all collected
 *     locally (per `slot`, by tx hash). Consumed by the data-withholding watcher.
 *  2. The outcome of locally re-executing each checkpoint proposal (keyed by
 *     `(checkpointNumber, archiveRoot)` and by `slot`). Consumed by the data-withholding
 *     watcher (via `hasReexecuted`) and the sentinel (via `getOutcomeForSlot` and `getRecordForSlot`).
 *
 * Both pieces of state live on the same per-slot `Entry`, so cleanup via `removeBefore`
 * naturally drops everything for a pruned slot in one step.
 */
interface Entry {
  // Set by recordOutcome — these may be undefined until the checkpoint proposal has been
  // evaluated. recordTxsCollected may create an Entry before any of them are known.
  checkpointNumber: CheckpointNumber | undefined;
  archiveRoot: string | undefined;
  lastArchiveRoot: string | undefined;
  payloadHash: CheckpointProposalHash | undefined;
  outcome: ReexecutionOutcome | undefined;

  slot: SlotNumber;

  // Hashes of the txs of every block proposal at this slot whose txs were all collected.
  collectedTxs: Set<string>;

  // Set by recordEquivocation when a proposal equivocation is seen for this slot. Consumed by the
  // sentinel: an honest attestor may have seen an invalid version of an equivocated proposal and
  // correctly declined, so it must not be counted as a missed attestor.
  equivocated: boolean;
}

export class CheckpointReexecutionTracker {
  private readonly byCheckpoint = new Map<CheckpointNumber, Map<string, Entry>>();
  private readonly bySlot = new Map<SlotNumber, Entry>();

  /**
   * Record the outcome of evaluating a checkpoint proposal.
   * @param slot - Slot the proposal was for. Always required.
   * @param archiveRoot - Archive root in the proposal.
   * @param outcome - Outcome of evaluation.
   * @param checkpointNumber - Checkpoint number, if known. Required for `valid` outcomes; optional
   *   for `invalid`/`unvalidated` because some early rejections fire before blocks are loaded.
   * @param details - The proposal's parent archive root and payload hash, if known. They let the sentinel tell whether
   *   a valid proposal that never landed was built on a parent that is on L1, and count only the attestations for it.
   */
  public recordOutcome(
    slot: SlotNumber,
    archiveRoot: Fr,
    outcome: ReexecutionOutcome,
    checkpointNumber?: CheckpointNumber,
    details: ReexecutionDetails = {},
  ): void {
    const archiveRootStr = archiveRoot.toString();

    // Preserve any collected txs already accumulated for this slot.
    const existing = this.bySlot.get(slot);
    const entry: Entry = {
      checkpointNumber,
      archiveRoot: archiveRootStr,
      lastArchiveRoot: details.lastArchiveRoot?.toString(),
      payloadHash: details.payloadHash,
      slot,
      outcome,
      collectedTxs: existing?.collectedTxs ?? new Set(),
      equivocated: existing?.equivocated ?? false,
    };

    if (checkpointNumber !== undefined) {
      let archives = this.byCheckpoint.get(checkpointNumber);
      if (!archives) {
        archives = new Map();
        this.byCheckpoint.set(checkpointNumber, archives);
      }
      archives.set(archiveRootStr, entry);
    }

    this.bySlot.set(slot, entry);
  }

  /**
   * Record that the local node collected every transaction of a block proposal before the deadline. Called from the
   * validator's proposal handler right after tx collection succeeds, before re-execution, so a failed collection
   * records nothing. The data-withholding watcher consults these records as an authoritative signal: tx availability
   * now is too weak (txs may have been evicted from the mempool by the time the watcher runs), but a record that the
   * txs *were* available at proposal time still vouches for the block.
   *
   * The record vouches, per tx, that this node held each listed tx at proposal time for this slot. A vouched tx counts
   * for whichever published block of the slot contains it, regardless of the block's index or the order of its txs,
   * and records from every proposal for the slot accumulate, so a later proposal does not replace an earlier one.
   *
   * @param slot - Slot the block proposal was for.
   * @param txHashes - The proposal's tx hashes.
   */
  public recordTxsCollected(slot: SlotNumber, txHashes: readonly TxHash[]): void {
    let entry = this.bySlot.get(slot);
    if (!entry) {
      entry = {
        checkpointNumber: undefined,
        archiveRoot: undefined,
        lastArchiveRoot: undefined,
        payloadHash: undefined,
        slot,
        outcome: undefined,
        collectedTxs: new Set(),
        equivocated: false,
      };
      this.bySlot.set(slot, entry);
    }
    for (const txHash of txHashes) {
      entry.collectedTxs.add(txHash.toString());
    }
  }

  /**
   * Record that a proposal equivocation was observed for a slot. The sentinel uses this to skip
   * missed-attestor accounting: with two conflicting proposals in the slot, an honest attestor
   * that saw an invalid one and declined must not be counted inactive.
   */
  public recordEquivocation(slot: SlotNumber): void {
    const entry = this.bySlot.get(slot);
    if (!entry) {
      this.bySlot.set(slot, {
        checkpointNumber: undefined,
        archiveRoot: undefined,
        lastArchiveRoot: undefined,
        payloadHash: undefined,
        slot,
        outcome: undefined,
        collectedTxs: new Set(),
        equivocated: true,
      });
    } else {
      entry.equivocated = true;
    }
  }

  /** Returns true if a proposal equivocation was recorded for the slot. */
  public hasEquivocation(slot: SlotNumber): boolean {
    return this.bySlot.get(slot)?.equivocated ?? false;
  }

  /**
   * Returns true if the given (checkpoint number, archive root) has been successfully
   * re-executed locally (outcome `valid`).
   */
  public hasReexecuted(checkpointNumber: CheckpointNumber, archiveRoot: Fr): boolean {
    return this.byCheckpoint.get(checkpointNumber)?.get(archiveRoot.toString())?.outcome === 'valid';
  }

  /** Returns the recorded outcome for a given slot, or undefined if no proposal was evaluated. */
  public getOutcomeForSlot(slot: SlotNumber): ReexecutionOutcome | undefined {
    return this.bySlot.get(slot)?.outcome;
  }

  /** Returns the full record of the proposal evaluated for a slot, or undefined if none was evaluated. */
  public getRecordForSlot(slot: SlotNumber): ReexecutionRecord | undefined {
    const entry = this.bySlot.get(slot);
    if (entry?.outcome === undefined) {
      return undefined;
    }
    return {
      outcome: entry.outcome,
      checkpointNumber: entry.checkpointNumber,
      archiveRoot: entry.archiveRoot,
      lastArchiveRoot: entry.lastArchiveRoot,
      payloadHash: entry.payloadHash,
    };
  }

  /**
   * Whether this slot's recorded outcome is `valid` *and* was recorded for this archive root.
   *
   * {@link hasReexecuted} answers the same question but needs a checkpoint number, which the paths that re-validate
   * a cached verdict do not always have: pruning the checkpoint's last block makes revalidation fail before the
   * blocks are loaded, so its failure carries no checkpoint number. Keyed by slot and archive, this still tells a
   * later local inability apart from a determination about the same checkpoint, while a different archive at the
   * same slot remains a different question that records as usual.
   */
  public hasValidOutcomeForSlot(slot: SlotNumber, archiveRoot: Fr): boolean {
    const entry = this.bySlot.get(slot);
    return entry?.outcome === 'valid' && entry.archiveRoot === archiveRoot.toString();
  }

  /**
   * Whether every given tx was recorded by {@link recordTxsCollected} for this slot, in any order and from any
   * proposals. `false` means some tx was not (we never saw a proposal carrying it, or failed to collect that
   * proposal's txs), so callers should fall back to a current-state check such as a mempool probe.
   */
  public hasCollectedTxs(slot: SlotNumber, txHashes: readonly TxHash[]): boolean {
    const collected = this.bySlot.get(slot)?.collectedTxs;
    return collected !== undefined && txHashes.every(txHash => collected.has(txHash.toString()));
  }

  /** Drops entries for checkpoints with `number < checkpointNumber`. */
  public removeBefore(checkpointNumber: CheckpointNumber): void {
    // Track the highest slot among checkpoints we're pruning. Once we know it, any slot
    // strictly below that watermark is older than the most recently pruned checkpoint and
    // can be dropped from `bySlot` too — including slot-only entries (no checkpoint number)
    // which would otherwise leak, because removing by checkpoint number can't reach them.
    let maxRemovedSlot: SlotNumber | undefined;
    for (const [n, archives] of this.byCheckpoint) {
      if (n < checkpointNumber) {
        for (const entry of archives.values()) {
          // Only drop the slot index if it still points at the entry we're removing.
          if (this.bySlot.get(entry.slot) === entry) {
            this.bySlot.delete(entry.slot);
          }
          if (maxRemovedSlot === undefined || entry.slot > maxRemovedSlot) {
            maxRemovedSlot = entry.slot;
          }
        }
        this.byCheckpoint.delete(n);
      }
    }

    if (maxRemovedSlot !== undefined) {
      for (const slot of [...this.bySlot.keys()]) {
        if (slot < maxRemovedSlot) {
          this.bySlot.delete(slot);
        }
      }
    }
  }
}
