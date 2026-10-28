import { MAX_TX_LIFETIME } from '@aztec-labs/constants';

import { computeTxExpirationTimestamp } from './compute_tx_expiration_timestamp.js';

describe('computeTxExpirationTimestamp', () => {
  const blockTimestamp = 99999n;
  const maxTxLifetime = BigInt(MAX_TX_LIFETIME);
  const secondsInHour = 3600n;
  const secondsIn30Mins = 60n * 30n;

  const compute = (expirationTimestamp: bigint, txLifetime?: number) =>
    computeTxExpirationTimestamp({ anchorBlockTimestamp: blockTimestamp, expirationTimestamp }, txLifetime);

  it('rounds down to the max allowed duration', () => {
    const maxTimestamp = blockTimestamp + maxTxLifetime;

    expect(compute(maxTimestamp + 87654n)).toBe(maxTimestamp);
    expect(compute(maxTimestamp + 123n)).toBe(maxTimestamp);
    expect(compute(maxTimestamp)).toBe(maxTimestamp);
  });

  it('rounds down to the nearest hour', () => {
    expect(compute(blockTimestamp + maxTxLifetime - 1n)).toBe(blockTimestamp + maxTxLifetime - secondsInHour);
    expect(compute(blockTimestamp + secondsInHour * 11n + 1n)).toBe(blockTimestamp + secondsInHour * 11n);
    expect(compute(blockTimestamp + secondsInHour * 2n + 123n)).toBe(blockTimestamp + secondsInHour * 2n);
    expect(compute(blockTimestamp + secondsInHour)).toBe(blockTimestamp + secondsInHour);
  });

  it('rounds down to 30 mins for duration between 30 mins to 1 hour', () => {
    expect(compute(blockTimestamp + secondsInHour - 1n)).toBe(blockTimestamp + secondsIn30Mins);
    expect(compute(blockTimestamp + secondsIn30Mins + 123n)).toBe(blockTimestamp + secondsIn30Mins);
    expect(compute(blockTimestamp + secondsIn30Mins)).toBe(blockTimestamp + secondsIn30Mins);
  });

  it('rounds down to 1 seconds for duration under 30 mins', () => {
    expect(compute(blockTimestamp + secondsIn30Mins - 1n)).toBe(blockTimestamp + secondsIn30Mins - 1n);
    expect(compute(blockTimestamp + 60n * 10n)).toBe(blockTimestamp + 60n * 10n);
    expect(compute(blockTimestamp + 1n)).toBe(blockTimestamp + 1n);
  });

  it('throws if the timestamp is equal to or less than the block timestamp', () => {
    expect(() => compute(blockTimestamp)).toThrow();
    expect(() => compute(blockTimestamp - 1n)).toThrow();
  });

  it('allows custom expiration timestamp', () => {
    const customTxLifetime = maxTxLifetime / 2n;
    expect(compute(blockTimestamp + maxTxLifetime, Number(customTxLifetime))).toBe(blockTimestamp + customTxLifetime);
  });

  it('throws if custom tx lifetime is greater than the max allowed', () => {
    const customTxLifetime = maxTxLifetime + 1n;
    expect(() => compute(blockTimestamp + maxTxLifetime, Number(customTxLifetime))).toThrow();
  });
});
