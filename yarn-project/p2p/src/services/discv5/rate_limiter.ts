import { LruMap } from '@aztec-labs/foundation/collection';
import type { UDPTransportServiceInit } from '@nethermindeth/discv5';

import type { Discv5RateLimiterOpts } from './config.js';

type TransportRateLimiter = NonNullable<UDPTransportServiceInit['rateLimiter']>;
type Quota = Discv5RateLimiterOpts['byIPQuota'];

/** Default number of source IPs whose packet budget is tracked at once. */
export const DEFAULT_DISCV5_MAX_TRACKED_IPS = 100_000;

/**
 * Packet rate limiter for the discv5 UDP transport, consulted for every incoming datagram before it is decoded.
 *
 * Responses to our own queries are always admitted. Any other packet must fit the budget of its source IP and then the
 * aggregate budget, and is dropped otherwise. No source is ever banned: an over-limit source is admitted again as its
 * budget refills. Per-IP budgets are kept for a bounded number of sources, evicting the least recently seen one. An
 * evicted source starts over with a full budget, and the aggregate budget still bounds the total admitted.
 *
 * Budgets follow the generic cell rate algorithm: a burst of `maxTokens` packets, refilled evenly over
 * `replenishAllEvery` ms. Each budget is a single theoretical arrival time (TAT), in ms since the limiter was created.
 */
export class Discv5RateLimiter implements TransportRateLimiter {
  private readonly startMs = Date.now();
  private readonly perIpTats: LruMap<string, number>;
  private globalTat = 0;
  /** Outstanding queries per IP; a reply from any of these IPs skips the budgets. */
  private readonly expectedResponses = new Map<string, number>();

  constructor(
    private readonly opts: Discv5RateLimiterOpts,
    maxTrackedIps = DEFAULT_DISCV5_MAX_TRACKED_IPS,
  ) {
    this.perIpTats = new LruMap(maxTrackedIps);
  }

  /** Number of source IPs whose per-IP budget is currently tracked. */
  public get trackedIpCount(): number {
    return this.perIpTats.size;
  }

  /** Returns whether a packet from this source IP should be decoded. */
  public allowEncodedPacket(ip: string): boolean {
    if (this.expectedResponses.has(ip)) {
      return true;
    }
    const now = Date.now() - this.startMs;

    // Per-IP first, so packets over a source's own budget do not spend the aggregate budget.
    const ipTat = takeToken(this.opts.byIPQuota, this.perIpTats.get(ip) ?? now, now);
    if (ipTat === undefined) {
      return false;
    }
    this.perIpTats.set(ip, ipTat);

    const globalTat = takeToken(this.opts.globalQuota, this.globalTat, now);
    if (globalTat === undefined) {
      return false;
    }
    this.globalTat = globalTat;
    return true;
  }

  /** Records a query we sent to this IP, so its reply is admitted regardless of budgets. */
  public addExpectedResponse(ip: string): void {
    this.expectedResponses.set(ip, (this.expectedResponses.get(ip) ?? 0) + 1);
  }

  /** Clears one outstanding query to this IP. */
  public removeExpectedResponse(ip: string): void {
    const count = this.expectedResponses.get(ip);
    if (count === undefined) {
      return;
    }
    if (count > 1) {
      this.expectedResponses.set(ip, count - 1);
    } else {
      this.expectedResponses.delete(ip);
    }
  }
}

/** Spends one token from a GCRA budget, returning its new TAT, or undefined if the budget is exhausted at `now`. */
function takeToken(quota: Quota, tat: number, now: number): number | undefined {
  const emissionIntervalMs = quota.replenishAllEvery / quota.maxTokens;
  if (now < tat + emissionIntervalMs - quota.replenishAllEvery) {
    return undefined;
  }
  return Math.max(now, tat) + emissionIntervalMs;
}
