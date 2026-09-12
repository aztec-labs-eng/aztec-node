import { Fr } from '@aztec-labs/foundation/curves/bn254';
import {
  type InboxMessagePosition,
  InboxMessagePrefixRef,
  type InboxMessageRange,
  updateInboxRollingHash,
} from '@aztec-labs/stdlib/messaging';
import { describe, expect, it } from '@jest/globals';

import {
  type StreamingBlockCheckInput,
  type StreamingBlockCheckReason,
  type StreamingBlockCountRange,
  type StreamingInboxMessageSource,
  checkStreamingBlockProposal,
  checkStreamingBlockProposalMetadata,
  isRetryableStreamingBlockCheckReason,
  readStreamingBlockBundle,
} from './streaming_inbox_checks.js';

const PER_BLOCK_CAP = 4;
const PER_CHECKPOINT_CAP = 6;

/**
 * In-memory ordered message log mirroring the archiver store's count semantics: positions and ranges derive from the
 * indexed leaves alone, and a range past the synced tip rejects instead of returning a short list.
 */
class FakeInboxView implements StreamingInboxMessageSource {
  private leaves: Fr[] = [];

  /** Appends leaves at the synced tip and returns the position after them. */
  append(count: number): InboxMessagePosition {
    for (let i = 0; i < count; i++) {
      this.leaves.push(new Fr(1000 + this.leaves.length));
    }
    return this.positionAt(BigInt(this.leaves.length));
  }

  /** Replaces the log from `index` on with fresh leaves, as a content-changing reorg does. */
  replaceFrom(index: number, count: number): void {
    this.leaves = this.leaves.slice(0, index);
    for (let i = 0; i < count; i++) {
      this.leaves.push(new Fr(5000 + this.leaves.length));
    }
  }

  positionAt(count: bigint): InboxMessagePosition {
    let rollingHash = Fr.ZERO;
    for (let i = 0; i < Number(count); i++) {
      rollingHash = updateInboxRollingHash(rollingHash, this.leaves[i]);
    }
    return { totalMessageCount: count, rollingHash };
  }

  getMessagePosition(count: bigint): Promise<InboxMessagePosition | undefined> {
    return Promise.resolve(count > BigInt(this.leaves.length) ? undefined : this.positionAt(count));
  }

  getL1ToL2MessageRange(start: bigint, end: bigint): Promise<InboxMessageRange> {
    if (start > end || end > BigInt(this.leaves.length)) {
      return Promise.reject(new Error(`Inbox message range [${start}, ${end}) is not fully synced`));
    }
    return Promise.resolve({
      messages: this.leaves.slice(Number(start), Number(end)),
      start: this.positionAt(start),
      end: this.positionAt(end),
    });
  }
}

/** Upper bound the checks apply to the error text they attach to a result. */
const MAX_REPORTED_ERROR_LENGTH = 200;

/** A message source whose range read always fails, for exercising the failure classification. */
function rejectingWith(err: Error): Pick<StreamingInboxMessageSource, 'getL1ToL2MessageRange'> {
  return { getL1ToL2MessageRange: () => Promise.reject(err) };
}

/** An arbitrary count range to feed a failing read; the range itself never reaches the source's contents. */
function failingRange(): StreamingBlockCountRange {
  return { parentTotalMsgCount: 0n, endTotalMsgCount: 1n, inboxPrefixRef: InboxMessagePrefixRef.random() };
}

function baseInput(overrides: Partial<StreamingBlockCheckInput>): StreamingBlockCheckInput {
  return {
    messageSource: new FakeInboxView(),
    inboxPrefixRef: InboxMessagePrefixRef.empty(),
    endTotalMsgCount: 0n,
    parentTotalMsgCount: 0n,
    checkpointStartTotalMsgCount: 0n,
    perBlockCap: PER_BLOCK_CAP,
    perCheckpointCap: PER_CHECKPOINT_CAP,
    ...overrides,
  };
}

describe('checkStreamingBlockProposal', () => {
  describe('check 1: consumption moves forward', () => {
    it('rejects an end count behind the parent block', async () => {
      const view = new FakeInboxView();
      const end = view.append(3);
      const result = await checkStreamingBlockProposal(
        baseInput({
          messageSource: view,
          inboxPrefixRef: InboxMessagePrefixRef.fromPosition(end),
          endTotalMsgCount: 3n,
          parentTotalMsgCount: 5n,
        }),
      );
      expect(result).toEqual({ accepted: false, reason: 'consumption_moves_backwards' });
    });
  });

  describe('check 2: caps', () => {
    it('rejects a bundle over the per-block cap', async () => {
      const view = new FakeInboxView();
      const end = view.append(PER_BLOCK_CAP + 1);
      const result = await checkStreamingBlockProposal(
        baseInput({
          messageSource: view,
          inboxPrefixRef: InboxMessagePrefixRef.fromPosition(end),
          endTotalMsgCount: end.totalMessageCount,
        }),
      );
      expect(result).toEqual({ accepted: false, reason: 'bundle_over_block_cap' });
    });

    it('rejects a running checkpoint total over the per-checkpoint cap', async () => {
      const view = new FakeInboxView();
      const end = view.append(PER_CHECKPOINT_CAP + 1);
      const result = await checkStreamingBlockProposal(
        baseInput({
          messageSource: view,
          inboxPrefixRef: InboxMessagePrefixRef.fromPosition(end),
          endTotalMsgCount: end.totalMessageCount,
          parentTotalMsgCount: BigInt(PER_CHECKPOINT_CAP + 1 - PER_BLOCK_CAP),
          checkpointStartTotalMsgCount: 0n,
        }),
      );
      expect(result).toEqual({ accepted: false, reason: 'checkpoint_over_msg_cap' });
    });
  });

  describe('check 3: prefix hash at the signed count', () => {
    it('rejects as unavailable when the local view has not synced the end count', async () => {
      const view = new FakeInboxView();
      view.append(2);
      const result = await checkStreamingBlockProposal(
        baseInput({ messageSource: view, inboxPrefixRef: InboxMessagePrefixRef.random(), endTotalMsgCount: 3n }),
      );
      expect(result).toEqual({ accepted: false, reason: 'inbox_prefix_unavailable' });
    });

    it('rejects as a mismatch when the local prefix hash at the end count differs', async () => {
      const view = new FakeInboxView();
      view.append(3);
      const result = await checkStreamingBlockProposal(
        baseInput({ messageSource: view, inboxPrefixRef: InboxMessagePrefixRef.random(), endTotalMsgCount: 3n }),
      );
      expect(result).toEqual({ accepted: false, reason: 'inbox_prefix_mismatch' });
    });

    it('checks the prefix of an empty block at its unchanged count', async () => {
      const view = new FakeInboxView();
      const end = view.append(3);
      const accepted = await checkStreamingBlockProposal(
        baseInput({
          messageSource: view,
          inboxPrefixRef: InboxMessagePrefixRef.fromPosition(end),
          endTotalMsgCount: 3n,
          parentTotalMsgCount: 3n,
        }),
      );
      expect(accepted).toEqual({ accepted: true, bundle: [] });

      const rejected = await checkStreamingBlockProposal(
        baseInput({
          messageSource: view,
          inboxPrefixRef: InboxMessagePrefixRef.random(),
          endTotalMsgCount: 3n,
          parentTotalMsgCount: 3n,
        }),
      );
      expect(rejected).toEqual({ accepted: false, reason: 'inbox_prefix_mismatch' });
    });

    it('accepts the genesis prefix on an empty view', async () => {
      const result = await checkStreamingBlockProposal(
        baseInput({ inboxPrefixRef: InboxMessagePrefixRef.empty(), endTotalMsgCount: 0n }),
      );
      expect(result).toEqual({ accepted: true, bundle: [] });
    });
  });

  describe('bundle derivation', () => {
    it('reads exactly the leaves between the parent count and the signed end count', async () => {
      const view = new FakeInboxView();
      view.append(2);
      const end = view.append(3);
      const result = await checkStreamingBlockProposal(
        baseInput({
          messageSource: view,
          inboxPrefixRef: InboxMessagePrefixRef.fromPosition(end),
          endTotalMsgCount: 5n,
          parentTotalMsgCount: 2n,
          checkpointStartTotalMsgCount: 2n,
        }),
      );
      expect(result).toEqual({
        accepted: true,
        bundle: (await view.getL1ToL2MessageRange(2n, 5n)).messages,
      });
      expect(result.accepted && result.bundle).toHaveLength(3);
    });

    // Intermediate blocks end at whatever prefix the proposer had observed; no bucket boundary is involved, and an
    // appended message leaves every earlier prefix hash intact.
    it('accepts a prefix interior to the synced log and is unaffected by later appends', async () => {
      const view = new FakeInboxView();
      const end = view.append(3);
      view.append(4);
      const result = await checkStreamingBlockProposal(
        baseInput({
          messageSource: view,
          inboxPrefixRef: InboxMessagePrefixRef.fromPosition(end),
          endTotalMsgCount: 3n,
          parentTotalMsgCount: 1n,
        }),
      );
      expect(result.accepted).toBe(true);
    });

    it('reports a replaced suffix as a mismatch on the bundle read, not as new leaves', async () => {
      const view = new FakeInboxView();
      const end = view.append(3);
      const metadata = await checkStreamingBlockProposalMetadata(
        baseInput({
          messageSource: view,
          inboxPrefixRef: InboxMessagePrefixRef.fromPosition(end),
          endTotalMsgCount: 3n,
        }),
      );
      expect(metadata.accepted).toBe(true);

      // A reorg replaces the last two messages between the metadata check and the bundle read.
      view.replaceFrom(1, 2);
      const result = await readStreamingBlockBundle(view, metadata as typeof metadata & { accepted: true });
      expect(result).toEqual({ accepted: false, reason: 'inbox_prefix_mismatch' });
    });

    it('reports a truncated suffix as unavailable on the bundle read', async () => {
      const view = new FakeInboxView();
      const end = view.append(3);
      const metadata = await checkStreamingBlockProposalMetadata(
        baseInput({
          messageSource: view,
          inboxPrefixRef: InboxMessagePrefixRef.fromPosition(end),
          endTotalMsgCount: 3n,
        }),
      );
      expect(metadata.accepted).toBe(true);

      view.replaceFrom(2, 0);
      const result = await readStreamingBlockBundle(view, metadata as typeof metadata & { accepted: true });
      expect(result).toEqual({ accepted: false, reason: 'inbox_prefix_unavailable' });
    });

    // The context is diagnostics only: a store fault still yields the same non-punitive verdict as sync lag, so the
    // validator does exactly what it did with the proposal.
    it('carries the error text of a range read that failed for an unanticipated reason', async () => {
      const result = await readStreamingBlockBundle(rejectingWith(new Error('database is closed')), failingRange());
      expect(result).toEqual({ accepted: false, reason: 'inbox_prefix_unavailable', error: 'database is closed' });
      expect(isRetryableStreamingBlockCheckReason((result as { reason: StreamingBlockCheckReason }).reason)).toBe(true);
    });

    it.each(['Inbox message range [0, 1) is not fully synced: ...', 'Invalid Inbox leaf count range [1, 0)'])(
      'attaches no context to ordinary sync lag: %s',
      async message => {
        const result = await readStreamingBlockBundle(rejectingWith(new Error(message)), failingRange());
        expect(result).toEqual({ accepted: false, reason: 'inbox_prefix_unavailable' });
        expect((result as { error?: string }).error).toBeUndefined();
        expect(isRetryableStreamingBlockCheckReason((result as { reason: StreamingBlockCheckReason }).reason)).toBe(
          true,
        );
      },
    );

    it('bounds the error text so a verbose provider failure cannot blow up a log record', async () => {
      const result = await readStreamingBlockBundle(rejectingWith(new Error('x'.repeat(5000))), failingRange());
      expect(result).toEqual({
        accepted: false,
        reason: 'inbox_prefix_unavailable',
        error: 'x'.repeat(MAX_REPORTED_ERROR_LENGTH),
      });
    });
  });
});
