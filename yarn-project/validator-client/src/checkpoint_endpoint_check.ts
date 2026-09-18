import type { InboxContract } from '@aztec-labs/ethereum/contracts';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';

/**
 * The L1 reads the checkpoint endpoint check makes: the height the view is pinned to, read once, and the bucket
 * resolution taken at it. Pinning is what keeps a retry sequence from mixing answers from a `latest` that moves
 * between attempts. {@link InboxContract} and a viem client satisfy this directly.
 */
export type InboxEndpointReader = Pick<InboxContract, 'getBucketAtOrBeforeTotal'> & {
  client: { getBlockNumber(): Promise<bigint> };
};

/** Why a checkpoint's final message position is not a live Inbox bucket endpoint in the L1 view that was read. */
export type InboxEndpointRejection =
  /** No live bucket ends at or below the position: the ring has evicted every bucket that could have matched. */
  | 'no_live_endpoint'
  /** The closest live boundary ends earlier, so the position falls inside a bucket rather than closing one. */
  | 'interior_position'
  /** A live bucket ends exactly there, but commits to a different message prefix than the checkpoint signed. */
  | 'rolling_hash_mismatch';

/**
 * The outcome of one endpoint check. A rejection describes the L1 view that was read at `l1BlockNumber`, not the
 * proposer: the bucket ring, this node's provider and the chain itself all move independently of the moment the
 * checkpoint was signed.
 */
export type InboxEndpointCheckResult =
  | { verified: true; l1BlockNumber: bigint; bucketSeq: bigint }
  | { verified: false; reason: InboxEndpointRejection; l1BlockNumber: bigint; endpointTotal?: bigint }
  /** A read threw: the provider is unreachable, erroring or unsynced. */
  | { verified: false; reason: 'unreadable'; l1BlockNumber?: bigint; err: unknown };

/**
 * Confirms through L1 that `totalMsgCount` is the end of a live Inbox bucket committing to `inboxRollingHash`.
 *
 * A checkpoint may consume an arbitrary prefix of the message log across its blocks, but the position it finishes
 * at has to be a live bucket boundary for L1 to accept it. The resolver answers with the newest boundary at or
 * below the bound, so only an exact total is a match: a lower one means the position sits inside a bucket. The
 * bucket's own rolling hash then has to be the one the checkpoint signed, or the boundary commits to different
 * message content than the checkpoint was built on.
 *
 * The height is read once and the resolution is pinned to it, so an answer belongs to a named view rather than to
 * whatever `latest` happened to be at the moment of the call. The block is not read back afterwards: an answer
 * from a provider on a stale fork is indistinguishable from a canonical one either way, and the checks that
 * actually protect against it — the proposer's own publication preflight and L1's `propose` — sit elsewhere.
 */
export async function checkInboxEndpoint(
  inbox: InboxEndpointReader,
  totalMsgCount: bigint,
  inboxRollingHash: Fr,
): Promise<InboxEndpointCheckResult> {
  let l1BlockNumber: bigint | undefined;
  try {
    l1BlockNumber = await inbox.client.getBlockNumber();
    const found = await inbox.getBucketAtOrBeforeTotal(totalMsgCount, { blockNumber: l1BlockNumber });
    if (found === undefined) {
      return { verified: false, reason: 'no_live_endpoint', l1BlockNumber };
    }
    const endpointTotal = found.bucket.totalMsgCount;
    if (endpointTotal !== totalMsgCount) {
      return { verified: false, reason: 'interior_position', l1BlockNumber, endpointTotal };
    }
    if (!found.bucket.rollingHash.equals(inboxRollingHash)) {
      return { verified: false, reason: 'rolling_hash_mismatch', l1BlockNumber, endpointTotal };
    }
    return { verified: true, l1BlockNumber, bucketSeq: found.seq };
  } catch (err) {
    return { verified: false, reason: 'unreadable', l1BlockNumber, err };
  }
}
