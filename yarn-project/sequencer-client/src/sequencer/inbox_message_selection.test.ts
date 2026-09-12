import { MAX_L1_TO_L2_MSGS_PER_BLOCK, MAX_L1_TO_L2_MSGS_PER_CHECKPOINT } from '@aztec-labs/constants';
import type { InboxContract } from '@aztec-labs/ethereum/contracts';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import { type MockProxy, mock } from 'jest-mock-extended';

import { type MockStreamingInbox, mockStreamingInbox } from '../test/utils.js';
import {
  PROTOCOL_INBOX_CONSUMPTION_CAPS,
  getEndpointUpperBound,
  getOrdinaryCeiling,
  mustQueryEndpoint,
  resolveEndpoint,
  selectOrdinaryMessageEnd,
  selectSafeLocalEnd,
} from './inbox_message_selection.js';

describe('resolveEndpoint', () => {
  let messageSource: MockProxy<L1ToL2MessageSource>;
  let inbox: MockProxy<InboxContract>;
  let streamingInbox: MockStreamingInbox;

  const leaves = (count: number) => Array.from({ length: count }, (_, i) => new Fr(i + 1));

  beforeEach(() => {
    messageSource = mock<L1ToL2MessageSource>();
    inbox = mock<InboxContract>();
    streamingInbox = mockStreamingInbox(messageSource, inbox);
  });

  it('resolves the live bucket end at or below the upper bound and reads the range from the cursor to it', async () => {
    streamingInbox.set(leaves(10), [4n, 7n, 10n]);

    const resolved = await resolveEndpoint({
      inbox,
      messageSource,
      cursor: streamingInbox.positionAt(2n),
      upperBound: 8n,
    });

    expect(resolved).toEqual(
      expect.objectContaining({ ok: true, bucketSeq: 2n, endpoint: streamingInbox.positionAt(7n) }),
    );
    expect(resolved.ok && resolved.range.messages).toEqual(leaves(10).slice(2, 7));
  });

  it('reports no live endpoint when no bucket ends at or below the upper bound', async () => {
    streamingInbox.set(leaves(10), [7n, 10n]);

    const resolved = await resolveEndpoint({
      inbox,
      messageSource,
      cursor: streamingInbox.positionAt(2n),
      upperBound: 6n,
    });

    // Only the genesis position (total zero) is at or below the bound, and it is behind the cursor.
    expect(resolved).toEqual({ ok: false, reason: 'endpoint_behind_cursor', upperBound: 6n, endpointTotal: 0n });
  });

  it('reports no live endpoint when the Inbox has evicted every bucket at or below the upper bound', async () => {
    streamingInbox.set(leaves(10), [7n, 10n]);
    inbox.getBucketAtOrBeforeTotal.mockResolvedValue(undefined);

    const resolved = await resolveEndpoint({
      inbox,
      messageSource,
      cursor: streamingInbox.positionAt(2n),
      upperBound: 8n,
    });

    expect(resolved).toEqual({ ok: false, reason: 'no_live_endpoint', upperBound: 8n });
  });

  it('reports the endpoint as unavailable locally when the archiver has not synced up to it', async () => {
    streamingInbox.set(leaves(5), [7n]);

    const resolved = await resolveEndpoint({
      inbox,
      messageSource,
      cursor: streamingInbox.positionAt(2n),
      upperBound: 8n,
    });

    expect(resolved).toEqual({ ok: false, reason: 'endpoint_unavailable_locally', upperBound: 8n, endpointTotal: 7n });
  });

  it('reports a changed local prefix when the range no longer starts at the cursor hash', async () => {
    streamingInbox.set(leaves(10), [7n]);
    const cursor = streamingInbox.positionAt(2n);
    streamingInbox.set([new Fr(100), new Fr(101), ...leaves(10).slice(2)], [7n]);

    const resolved = await resolveEndpoint({ inbox, messageSource, cursor, upperBound: 8n });

    expect(resolved).toEqual({ ok: false, reason: 'local_prefix_changed', upperBound: 8n, endpointTotal: 7n });
  });

  // The local log and the Inbox can disagree at the endpoint itself: the archiver holds a stale suffix (an L1 reorg it
  // has not followed yet) whose prefix hash at the bucket end differs from the live bucket's. Such an endpoint must not
  // be signed: the checkpoint header would commit to a rolling hash L1 does not hold.
  it('reports an endpoint hash mismatch when the local prefix at the bucket end differs from the live bucket', async () => {
    streamingInbox.set(leaves(10), [7n]);
    const resolveBucket = inbox.getBucketAtOrBeforeTotal.getMockImplementation()!;
    inbox.getBucketAtOrBeforeTotal.mockImplementation(async upperBound => {
      const found = await resolveBucket(upperBound);
      return found && { ...found, bucket: { ...found.bucket, rollingHash: Fr.random() } };
    });

    const resolved = await resolveEndpoint({
      inbox,
      messageSource,
      cursor: streamingInbox.positionAt(2n),
      upperBound: 8n,
    });

    expect(resolved).toEqual({ ok: false, reason: 'endpoint_hash_mismatch', upperBound: 8n, endpointTotal: 7n });
  });
});

// The local-only step is what a node reuses to guess the next block's bundle when simulating public calls. It is an
// estimate in both directions: a final block lands on a live bucket boundary, which can be behind that step.
describe('local selection against the final block that has to land on a bucket boundary', () => {
  const caps = PROTOCOL_INBOX_CONSUMPTION_CAPS;

  it('ends a final block below the local step when the last boundary in reach is behind it', async () => {
    const messageSource = mock<L1ToL2MessageSource>();
    const inbox = mock<InboxContract>();
    const streamingInbox = mockStreamingInbox(messageSource, inbox);
    // Cursor at the checkpoint start, 400 messages observed, live buckets ending at 200 and 400.
    streamingInbox.set(
      Array.from({ length: 400 }, (_, i) => new Fr(i + 1)),
      [200n, 400n],
    );
    const selection = { cursorCount: 0n, localSyncedCount: 400n, checkpointStartCount: 0n, caps };

    const localEnd = selectSafeLocalEnd(selection);
    const upperBound = getEndpointUpperBound({ ...selection, isFinalBlock: true });
    const resolved = await resolveEndpoint({
      inbox,
      messageSource,
      cursor: streamingInbox.positionAt(0n),
      upperBound,
    });

    // The local step takes a full block; the final block stops at the boundary below it.
    expect(localEnd).toEqual(256n);
    expect(upperBound).toEqual(256n);
    const finalBlockEnd = resolved.ok ? resolved.endpoint.totalMessageCount : undefined;
    expect(finalBlockEnd).toEqual(200n);
    // A public call using message index 220 runs against a message the local step covers and the block never inserts.
    const messageIndex = 220n;
    expect(messageIndex < localEnd).toBe(true);
    expect(messageIndex >= finalBlockEnd!).toBe(true);
  });
});

describe('ordinary message selection', () => {
  const caps = PROTOCOL_INBOX_CONSUMPTION_CAPS;
  // 1024 - 256: the last position from which one block always reaches the end of the bucket the cursor sits in.
  const threshold = 768n;

  it.each([0n, 5_000n])('takes everything observed within the caps from checkpoint start %s', start => {
    expect(getOrdinaryCeiling(start, caps)).toEqual(start + threshold);
    // The greedy end is not held down to the threshold; the threshold only decides whether L1 has to be consulted.
    expect(
      selectOrdinaryMessageEnd({
        cursorCount: start + 700n,
        localSyncedCount: start + 1000n,
        checkpointStartCount: start,
        caps,
      }),
    ).toEqual(start + 956n);
    // The per-block cap and the checkpoint cap both bound it.
    expect(
      selectOrdinaryMessageEnd({
        cursorCount: start,
        localSyncedCount: start + 700n,
        checkpointStartCount: start,
        caps,
      }),
    ).toEqual(start + 256n);
    expect(
      selectOrdinaryMessageEnd({
        cursorCount: start + 900n,
        localSyncedCount: start + 1300n,
        checkpointStartCount: start,
        caps,
      }),
    ).toEqual(start + 1024n);
  });

  it.each([0n, 5_000n])('holds the safe local step at the threshold from checkpoint start %s', start => {
    expect(
      selectSafeLocalEnd({
        cursorCount: start + 700n,
        localSyncedCount: start + 1000n,
        checkpointStartCount: start,
        caps,
      }),
    ).toEqual(start + threshold);
    // Never below the cursor, even once the cursor is past the threshold.
    for (const cursorCount of [start + threshold, start + 900n]) {
      expect(
        selectSafeLocalEnd({ cursorCount, localSyncedCount: start + 1024n, checkpointStartCount: start, caps }),
      ).toEqual(cursorCount);
    }
  });

  it('rejects caps whose checkpoint budget is below one bucket', () => {
    expect(() => getOrdinaryCeiling(0n, { perCheckpointCap: 128, maxMessagesPerBucket: 256 })).toThrow(
      'below the bucket size',
    );
  });
});

describe('mustQueryEndpoint', () => {
  const caps = PROTOCOL_INBOX_CONSUMPTION_CAPS;

  it.each([0n, 5_000n])('triggers strictly above the threshold, from checkpoint start %s', start => {
    const at = (prospectiveEnd: bigint, isFinalBlock = false) =>
      mustQueryEndpoint({ prospectiveEnd, checkpointStartCount: start, isFinalBlock, caps });

    // A step ending exactly on the threshold is still local-only.
    expect(at(start + 768n)).toBe(false);
    expect(at(start + 769n)).toBe(true);
    // A large backlog does not trigger a lookup while the step itself stays clear of the threshold.
    expect(at(start + 256n)).toBe(false);
    // The final block always lands on a live bucket end, however little it consumes.
    expect(at(start, true)).toBe(true);
  });
});

describe('getEndpointUpperBound', () => {
  const caps = PROTOCOL_INBOX_CONSUMPTION_CAPS;

  it.each([0n, 5_000n])('bounds a non-final lookup by the checkpoint, from start %s', start => {
    const bound = (cursorCount: bigint, localSyncedCount: bigint) =>
      getEndpointUpperBound({
        cursorCount,
        localSyncedCount,
        checkpointStartCount: start,
        isFinalBlock: false,
        caps,
      });

    // The whole checkpoint cap, not this block's reach: a mandatory bucket past 956 must not be stranded.
    expect(bound(start + 700n, start + 1_300n)).toEqual(start + 1024n);
    // What the archiver holds, when that is less.
    expect(bound(start + 700n, start + 800n)).toEqual(start + 800n);
  });

  it.each([0n, 5_000n])('bounds a final lookup by one block as well, from start %s', start => {
    const bound = (cursorCount: bigint, localSyncedCount: bigint) =>
      getEndpointUpperBound({ cursorCount, localSyncedCount, checkpointStartCount: start, isFinalBlock: true, caps });

    expect(bound(start + 700n, start + 1_300n)).toEqual(start + 956n);
    expect(bound(start + 768n, start + 1_300n)).toEqual(start + 1024n);
    expect(bound(start + 700n, start + 800n)).toEqual(start + 800n);
  });
});

// The protocol boundaries a block's message selection has to respect, asserted at the generated constants rather
// than at the small injected caps the semantic tests use. These are the counts an L1 bucket rollover and a
// cap-sized backlog actually produce, so a mis-wired constant shows up here instead of in an e2e sweep.
describe('protocol message-count boundaries', () => {
  const caps = PROTOCOL_INBOX_CONSUMPTION_CAPS;
  const perBlock = BigInt(caps.perBlockCap);
  const perCheckpoint = BigInt(caps.perCheckpointCap);

  it('uses the generated per-block and per-checkpoint caps', () => {
    expect(caps.perBlockCap).toEqual(MAX_L1_TO_L2_MSGS_PER_BLOCK);
    expect(caps.perCheckpointCap).toEqual(MAX_L1_TO_L2_MSGS_PER_CHECKPOINT);
    // An L1 bucket holds at most one block's worth, which is what lets a cursor left one bucket below the
    // checkpoint cap always reach the end of the bucket it sits in.
    expect(caps.maxMessagesPerBucket).toEqual(caps.perBlockCap);
    expect(caps.perCheckpointCap / caps.perBlockCap).toEqual(4);
  });

  // From an empty checkpoint, a block takes everything observed up to its own cap, and the checkpoint's whole
  // budget bounds the run of blocks after it. 255/256 are the last count one block carries whole and the cap
  // itself; 257 is the first that has to spill into a second block; 1024/1025 are the same pair for the checkpoint.
  it.each([
    [0, 0n, 0n],
    [1, 1n, 1n],
    [255, 255n, 255n],
    [256, 256n, 256n],
    [257, 256n, 257n],
    [1024, 256n, 1024n],
    [1025, 256n, 1024n],
  ])('selects at most one block and one checkpoint out of %i observed messages', (observed, firstBlock, wholeRun) => {
    const localSyncedCount = BigInt(observed);
    const first = selectOrdinaryMessageEnd({
      cursorCount: 0n,
      localSyncedCount,
      checkpointStartCount: 0n,
      caps,
    });
    expect(first).toEqual(firstBlock);
    expect(first - 0n).toBeLessThanOrEqual(perBlock);

    // Four blocks, each taking its whole cap, is the most a checkpoint may consume; past 1024 the rest waits.
    let cursorCount = 0n;
    for (let block = 0; block < 4; block++) {
      cursorCount = selectOrdinaryMessageEnd({ cursorCount, localSyncedCount, checkpointStartCount: 0n, caps });
    }
    expect(cursorCount).toEqual(wholeRun);
    expect(cursorCount).toBeLessThanOrEqual(perCheckpoint);
  });

  // A 257-message L1 batch is the rollover case: L1 opens a second bucket at 256, and no single block may take all
  // 257 however much the archiver has observed.
  it('never lets one block consume the 257 messages of a rolled-over batch', () => {
    const selection = { cursorCount: 0n, localSyncedCount: 257n, checkpointStartCount: 0n, caps };
    expect(selectOrdinaryMessageEnd(selection)).toEqual(256n);
    expect(selectSafeLocalEnd(selection)).toEqual(256n);
    // Ending exactly on the bucket boundary needs no L1 lookup; the next block picks up the 257th message.
    expect(mustQueryEndpoint({ prospectiveEnd: 256n, checkpointStartCount: 0n, isFinalBlock: false, caps })).toBe(
      false,
    );
    expect(
      selectOrdinaryMessageEnd({ cursorCount: 256n, localSyncedCount: 257n, checkpointStartCount: 0n, caps }),
    ).toEqual(257n);
  });

  // The cap is a hard stop, not a soft one: a cursor already at 1024 consumes nothing more in this checkpoint even
  // with a 1025th message observed.
  it('stops at the checkpoint cap with a 1025th message observed', () => {
    const atCap = { cursorCount: perCheckpoint, localSyncedCount: 1025n, checkpointStartCount: 0n, caps };
    expect(selectOrdinaryMessageEnd(atCap)).toEqual(perCheckpoint);
    expect(selectSafeLocalEnd(atCap)).toEqual(perCheckpoint);
    expect(getEndpointUpperBound({ ...atCap, isFinalBlock: true, caps })).toEqual(perCheckpoint);
  });

  // 768 is the last prospective end a non-final block may take on its local view alone: from there one block still
  // reaches the end of any bucket it lands in without passing the checkpoint's last legal endpoint.
  it.each([0n, 5_000n])('keeps the endpoint lookup local through 768 and mandatory from 769, at start %s', start => {
    const at = (prospectiveEnd: bigint) =>
      mustQueryEndpoint({ prospectiveEnd, checkpointStartCount: start, isFinalBlock: false, caps });

    expect(getOrdinaryCeiling(start, caps)).toEqual(start + 768n);
    expect(at(start + 767n)).toBe(false);
    expect(at(start + 768n)).toBe(false);
    expect(at(start + 769n)).toBe(true);

    // The safe local step is held to the threshold from either side of it.
    const safe = (localSyncedCount: bigint) =>
      selectSafeLocalEnd({ cursorCount: start + 600n, localSyncedCount, checkpointStartCount: start, caps });
    expect(safe(start + 767n)).toEqual(start + 767n);
    expect(safe(start + 768n)).toEqual(start + 768n);
    expect(safe(start + 769n)).toEqual(start + 768n);
  });
});
