import { jest } from '@jest/globals';

import type { Discv5RateLimiterOpts } from './config.js';
import { Discv5RateLimiter } from './rate_limiter.js';

describe('Discv5RateLimiter', () => {
  const replenishMs = 60_000;
  const opts: Discv5RateLimiterOpts = {
    byIPQuota: { maxTokens: 300, replenishAllEvery: replenishMs },
    globalQuota: { maxTokens: 6_000, replenishAllEvery: replenishMs },
  };
  const ip = '198.51.100.9';

  const countAllowed = (limiter: Discv5RateLimiter, sourceIp: string, packets: number) =>
    Array.from({ length: packets }, () => limiter.allowEncodedPacket(sourceIp)).filter(Boolean).length;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('admits a burst up to the per-IP budget and drops the rest', () => {
    const limiter = new Discv5RateLimiter(opts);
    expect(countAllowed(limiter, ip, 301)).toBe(300);
    expect(limiter.allowEncodedPacket(ip)).toBe(false);
  });

  it('admits expected responses after a burst', () => {
    const limiter = new Discv5RateLimiter(opts);
    expect(countAllowed(limiter, ip, 301)).toBe(300);

    limiter.addExpectedResponse(ip);
    expect(countAllowed(limiter, ip, 1_000)).toBe(1_000);
    limiter.removeExpectedResponse(ip);
    expect(limiter.allowEncodedPacket(ip)).toBe(false);
  });

  it('keeps a source exempt until all of its expected responses are removed', () => {
    const limiter = new Discv5RateLimiter(opts);
    expect(countAllowed(limiter, ip, 301)).toBe(300);

    limiter.addExpectedResponse(ip);
    limiter.addExpectedResponse(ip);
    limiter.removeExpectedResponse(ip);
    expect(limiter.allowEncodedPacket(ip)).toBe(true);
    limiter.removeExpectedResponse(ip);
    expect(limiter.allowEncodedPacket(ip)).toBe(false);
    limiter.removeExpectedResponse(ip);
    expect(limiter.allowEncodedPacket(ip)).toBe(false);
  });

  it('admits unsolicited packets again once the budget refills', () => {
    const limiter = new Discv5RateLimiter(opts);
    expect(countAllowed(limiter, ip, 301)).toBe(300);

    jest.advanceTimersByTime(replenishMs / opts.byIPQuota.maxTokens);
    expect(countAllowed(limiter, ip, 2)).toBe(1);

    jest.advanceTimersByTime(replenishMs);
    expect(countAllowed(limiter, ip, 301)).toBe(300);
  });

  it('does not spend the global budget on packets over a per-IP budget', () => {
    const limiter = new Discv5RateLimiter({
      byIPQuota: { maxTokens: 7, replenishAllEvery: replenishMs },
      globalQuota: { maxTokens: 20, replenishAllEvery: replenishMs },
    });
    expect(countAllowed(limiter, '203.0.113.1', 50)).toBe(7);

    const freshIps = Array.from({ length: 20 }, (_, i) => `198.51.100.${i + 1}`);
    expect(freshIps.filter(freshIp => limiter.allowEncodedPacket(freshIp)).length).toBe(13);
  });

  it('keeps per-IP state bounded', () => {
    const maxTrackedIps = 16;
    const limiter = new Discv5RateLimiter(
      {
        byIPQuota: { maxTokens: 2, replenishAllEvery: replenishMs },
        globalQuota: { maxTokens: 100, replenishAllEvery: replenishMs },
      },
      maxTrackedIps,
    );

    let admitted = 0;
    for (let i = 0; i < 5_000; i++) {
      if (limiter.allowEncodedPacket(`10.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}`)) {
        admitted++;
      }
      expect(limiter.trackedIpCount).toBeLessThanOrEqual(maxTrackedIps);
    }
    expect(limiter.trackedIpCount).toBe(maxTrackedIps);
    expect(admitted).toBe(100);
  });

  it('keeps recently seen sources tracked when new sources arrive', () => {
    const limiter = new Discv5RateLimiter(
      {
        byIPQuota: { maxTokens: 2, replenishAllEvery: replenishMs },
        globalQuota: { maxTokens: 1_000, replenishAllEvery: replenishMs },
      },
      2,
    );
    expect(countAllowed(limiter, ip, 3)).toBe(2);

    for (let i = 1; i <= 3; i++) {
      limiter.allowEncodedPacket(`203.0.113.${i}`);
      expect(limiter.allowEncodedPacket(ip)).toBe(false);
    }
    expect(limiter.trackedIpCount).toBe(2);
  });
});
