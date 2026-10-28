import { MAX_TX_LIFETIME } from '@aztec-labs/constants';

import { roundDownTxExpirationTimestamp } from './round_down_tx_expiration_timestamp.js';

describe('roundDownTxExpirationTimestamp', () => {
  let request: { anchorBlockTimestamp: bigint; maxExpirationTimestamp: bigint };

  const blockTimestamp = 99999n;
  const maxTxLifetime = BigInt(MAX_TX_LIFETIME);
  const secondsInHour = 3600n;
  const secondsIn30Mins = 60n * 30n;

  const setExpirationTimestamp = (timestamp: bigint) => {
    request.maxExpirationTimestamp = timestamp;
  };

  beforeEach(() => {
    request = { anchorBlockTimestamp: blockTimestamp, maxExpirationTimestamp: 0n };
  });

  it('rounds down to the max allowed duration', () => {
    const maxTimestamp = blockTimestamp + maxTxLifetime;

    setExpirationTimestamp(maxTimestamp + 87654n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(maxTimestamp);

    setExpirationTimestamp(maxTimestamp + 123n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(maxTimestamp);

    setExpirationTimestamp(maxTimestamp);
    expect(roundDownTxExpirationTimestamp(request)).toBe(maxTimestamp);
  });

  it('rounds down to the nearest hour', () => {
    setExpirationTimestamp(blockTimestamp + maxTxLifetime - 1n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + maxTxLifetime - secondsInHour);

    setExpirationTimestamp(blockTimestamp + secondsInHour * 11n + 1n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + secondsInHour * 11n);

    setExpirationTimestamp(blockTimestamp + secondsInHour * 2n + 123n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + secondsInHour * 2n);

    setExpirationTimestamp(blockTimestamp + secondsInHour);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + secondsInHour);
  });

  it('rounds down to 30 mins for duration between 30 mins to 1 hour', () => {
    setExpirationTimestamp(blockTimestamp + secondsInHour - 1n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + secondsIn30Mins);

    setExpirationTimestamp(blockTimestamp + secondsIn30Mins + 123n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + secondsIn30Mins);

    setExpirationTimestamp(blockTimestamp + secondsIn30Mins);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + secondsIn30Mins);
  });

  it('rounds down to 1 seconds for duration under 30 mins', () => {
    setExpirationTimestamp(blockTimestamp + secondsIn30Mins - 1n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + secondsIn30Mins - 1n);

    setExpirationTimestamp(blockTimestamp + 60n * 10n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + 60n * 10n);

    setExpirationTimestamp(blockTimestamp + 1n);
    expect(roundDownTxExpirationTimestamp(request)).toBe(blockTimestamp + 1n);
  });

  it('throws if the timestamp is equal to or less than the block timestamp', () => {
    setExpirationTimestamp(blockTimestamp);
    expect(() => roundDownTxExpirationTimestamp(request)).toThrow();

    setExpirationTimestamp(blockTimestamp - 1n);
    expect(() => roundDownTxExpirationTimestamp(request)).toThrow();
  });

  it('allows custom expiration timestamp', () => {
    setExpirationTimestamp(blockTimestamp + maxTxLifetime);
    const customTxLifetime = maxTxLifetime / 2n;
    const expirationTimestamp = roundDownTxExpirationTimestamp(request, Number(customTxLifetime));
    expect(expirationTimestamp).toBe(blockTimestamp + customTxLifetime);
  });

  it('throws if custom tx lifetime is greater than the max allowed', () => {
    const customTxLifetime = maxTxLifetime + 1n;
    expect(() => roundDownTxExpirationTimestamp(request, Number(customTxLifetime))).toThrow();
  });
});
