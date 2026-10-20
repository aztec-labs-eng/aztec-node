import { LruMap } from '@aztec-labs/foundation/collection';
import type { UDPTransportServiceInit } from '@nethermindeth/discv5';

import type { Discv5RateLimiterOpts } from './config.js';

type TransportRateLimiter = NonNullable<UDPTransportServiceInit['rateLimiter']>;
type Quota = Discv5RateLimiterOpts['byIPQuota'];

/** Bounds on the state the discv5 rate limiter keeps per source IP. */
export type Discv5RateLimiterBounds = {
  /** Number of source IPs whose packet budget, and separately whose reply exemption, is tracked at once. */
  maxTrackedIps: number;
  /** Time in ms a reply exemption lasts after the latest request to that IP. */
  expectedResponseTtlMs: number;
  /** Packets admitted without budget per request sent to an IP. */
  expectedResponseAllowance: number;
  /** Cap on the exempt packets an IP can accumulate across overlapping requests. */
  maxExpectedResponseAllowance: number;
};

/** Default bounds. The reply exemption outlives the node's 2 s request timeout across a few retries. */
export const DEFAULT_DISCV5_RATE_LIMITER_BOUNDS: Discv5RateLimiterBounds = {
  maxTrackedIps: 100_000,
  expectedResponseTtlMs: 10_000,
  expectedResponseAllowance: 16,
  maxExpectedResponseAllowance: 64,
};

/** Reply exemption for one IP, granted by our own requests to it. */
type ExpectedResponse = {
  /** Requests to this IP not yet completed. */
  outstanding: number;
  /** Exempt packets left. */
  allowance: number;
  /** Time, in ms since the limiter was created, at which the exemption ends. */
  expiresAt: number;
};

/**
 * Packet rate limiter for the discv5 UDP transport, consulted for every incoming datagram before it is decoded.
 *
 * Replies to our own requests are admitted without budget, up to a small packet allowance per request and for a short
 * time after it. Any other packet must fit the budget of its source IP and then the aggregate budget, and is dropped
 * otherwise. No source is ever banned: an over-limit source is admitted again as its budget refills.
 *
 * Per-IP budgets and reply exemptions are each kept for a bounded number of IPs, evicting the least recently seen one.
 * An evicted source starts over with a full budget, and the aggregate budget still bounds the total admitted.
 *
 * Budgets follow the generic cell rate algorithm: a burst of `maxTokens` packets, refilled evenly over
 * `replenishAllEvery` ms. Each budget is a single theoretical arrival time (TAT), in ms since the limiter was created.
 */
export class Discv5RateLimiter implements TransportRateLimiter {
  private readonly startMs = Date.now();
  private readonly bounds: Discv5RateLimiterBounds;
  private readonly perIpTats: LruMap<string, number>;
  private globalTat = 0;
  private readonly expectedResponses: LruMap<string, ExpectedResponse>;

  /** @throws If a bound is not a positive integer. */
  constructor(
    private readonly opts: Discv5RateLimiterOpts,
    bounds: Partial<Discv5RateLimiterBounds> = {},
  ) {
    this.bounds = { ...DEFAULT_DISCV5_RATE_LIMITER_BOUNDS, ...bounds };
    for (const [key, value] of Object.entries(this.bounds)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid discv5 rate limiter ${key}: expected a positive integer, got ${value}`);
      }
    }
    this.perIpTats = new LruMap(this.bounds.maxTrackedIps);
    this.expectedResponses = new LruMap(this.bounds.maxTrackedIps);
  }

  /** Number of source IPs whose per-IP budget is currently tracked. */
  public get trackedIpCount(): number {
    return this.perIpTats.size;
  }

  /** Number of IPs with a reply exemption currently tracked. */
  public get expectedResponseIpCount(): number {
    return this.expectedResponses.size;
  }

  /** Returns whether a packet from this source IP should be decoded. */
  public allowEncodedPacket(ip: string): boolean {
    const now = this.now();
    if (this.takeExemption(ip, now)) {
      return true;
    }

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

  /** Records a request we sent to this IP, so a few packets of its reply are admitted regardless of budgets. */
  public addExpectedResponse(ip: string): void {
    const now = this.now();
    const expiresAt = now + this.bounds.expectedResponseTtlMs;
    const entry = this.expectedResponses.get(ip);
    if (entry === undefined || now >= entry.expiresAt) {
      this.expectedResponses.set(ip, { outstanding: 1, allowance: this.bounds.expectedResponseAllowance, expiresAt });
      return;
    }
    entry.outstanding++;
    entry.allowance = Math.min(
      entry.allowance + this.bounds.expectedResponseAllowance,
      this.bounds.maxExpectedResponseAllowance,
    );
    entry.expiresAt = expiresAt;
  }

  /** Clears one outstanding request to this IP, ending its exemption once none are left. */
  public removeExpectedResponse(ip: string): void {
    const entry = this.expectedResponses.get(ip);
    if (entry === undefined) {
      return;
    }
    entry.outstanding--;
    if (entry.outstanding <= 0) {
      this.expectedResponses.delete(ip);
    }
  }

  /** Spends one exempt packet for this IP, returning false if it has no live exemption with allowance left. */
  private takeExemption(ip: string, now: number): boolean {
    const entry = this.expectedResponses.get(ip);
    if (entry === undefined) {
      return false;
    }
    if (now >= entry.expiresAt) {
      this.expectedResponses.delete(ip);
      return false;
    }
    if (entry.allowance <= 0) {
      return false;
    }
    entry.allowance--;
    return true;
  }

  private now(): number {
    return Date.now() - this.startMs;
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
