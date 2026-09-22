import { PeerErrorSeverity, type ValidationResult } from '@aztec-labs/stdlib/p2p';

// Grace beyond the (disparity-widened) receive window within which a miss is treated as benign
// propagation delay rather than a penalizable stale message: an honest relayer can forward a message
// that expires in the few hundred ms it takes to reach the next hop, and penalizing that relayer is
// the bug. A miss larger than this is the peer relaying something clearly stale or from the wrong
// window, which is sender-attributable.
export const RECEIVE_WINDOW_IGNORE_GRACE_MS = 500;

/**
 * Classify a gossip message's arrival time against its receive window (both bounds already widened by
 * the clock-disparity tolerance). Returns undefined when the arrival is in window and the caller
 * should proceed. Otherwise it returns the outcome and how far outside the window the arrival fell: a
 * small miss is ignored without penalty; a miss beyond the grace is rejected with HighToleranceError.
 */
export function classifyReceiveWindowArrival(
  nowMs: number,
  lowerBoundMs: number,
  upperBoundMs: number,
): { outcome: ValidationResult; missMs: number } | undefined {
  if (nowMs >= lowerBoundMs && nowMs <= upperBoundMs) {
    return undefined;
  }
  const missMs = nowMs < lowerBoundMs ? lowerBoundMs - nowMs : nowMs - upperBoundMs;
  const outcome: ValidationResult =
    missMs <= RECEIVE_WINDOW_IGNORE_GRACE_MS
      ? { result: 'ignore' }
      : { result: 'reject', severity: PeerErrorSeverity.HighToleranceError };
  return { outcome, missMs };
}
