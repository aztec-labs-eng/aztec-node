import { MAX_TX_LIFETIME } from '@aztec-labs/constants';
import { PrivateKernelCircuitPublicInputs } from '@aztec-labs/stdlib/kernel';

import { computeTxExpirationTimestamp } from './compute_tx_expiration_timestamp.js';

describe('computeTxExpirationTimestamp', () => {
  let previousKernel: PrivateKernelCircuitPublicInputs;

  const blockTimestamp = 99999n;
  const maxTxLifetime = BigInt(MAX_TX_LIFETIME);
  const secondsInHour = 3600n;
  const secondsIn30Mins = 60n * 30n;

  const setExpirationTimestamp = (timestamp: bigint) => {
    previousKernel.expirationTimestamp = timestamp;
  };

  beforeEach(() => {
    previousKernel = PrivateKernelCircuitPublicInputs.empty();
    previousKernel.constants.anchorBlockHeader.globalVariables.timestamp = blockTimestamp;
  });

  it('publishes one second under the max for the default update delay and anything above it', () => {
    const maxTimestamp = blockTimestamp + maxTxLifetime;
    const published = maxTimestamp - 1n;

    // Every callee on the default update delay: the kernel emits maxTimestamp - 1.
    setExpirationTimestamp(maxTimestamp - 1n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(published);

    // Every callee with a delay raised above the default: the kernel emits maxTimestamp.
    setExpirationTimestamp(maxTimestamp);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(published);

    setExpirationTimestamp(maxTimestamp + 123n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(published);

    setExpirationTimestamp(maxTimestamp + 87654n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(published);
  });

  it('rounds down to the nearest hour', () => {
    setExpirationTimestamp(blockTimestamp + maxTxLifetime - 2n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + maxTxLifetime - secondsInHour);

    setExpirationTimestamp(blockTimestamp + secondsInHour * 11n + 1n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + secondsInHour * 11n);

    setExpirationTimestamp(blockTimestamp + secondsInHour * 2n + 123n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + secondsInHour * 2n);

    setExpirationTimestamp(blockTimestamp + secondsInHour);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + secondsInHour);
  });

  it('rounds down to 30 mins for duration between 30 mins to 1 hour', () => {
    setExpirationTimestamp(blockTimestamp + secondsInHour - 1n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + secondsIn30Mins);

    setExpirationTimestamp(blockTimestamp + secondsIn30Mins + 123n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + secondsIn30Mins);

    setExpirationTimestamp(blockTimestamp + secondsIn30Mins);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + secondsIn30Mins);
  });

  it('rounds down to the nearest minute for duration under 30 mins', () => {
    setExpirationTimestamp(blockTimestamp + secondsIn30Mins - 1n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + secondsIn30Mins - 60n);

    setExpirationTimestamp(blockTimestamp + 60n * 10n + 59n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + 60n * 10n);
  });

  it('rounds down to 1 second for duration under 1 min', () => {
    setExpirationTimestamp(blockTimestamp + 59n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + 59n);

    setExpirationTimestamp(blockTimestamp + 1n);
    expect(computeTxExpirationTimestamp(previousKernel)).toBe(blockTimestamp + 1n);
  });

  it('throws if the timestamp is equal to or less than the block timestamp', () => {
    setExpirationTimestamp(blockTimestamp);
    expect(() => computeTxExpirationTimestamp(previousKernel)).toThrow();

    setExpirationTimestamp(blockTimestamp - 1n);
    expect(() => computeTxExpirationTimestamp(previousKernel)).toThrow();
  });

  it('allows custom expiration timestamp', () => {
    setExpirationTimestamp(blockTimestamp + maxTxLifetime);
    const customTxLifetime = maxTxLifetime / 2n;
    const expirationTimestamp = computeTxExpirationTimestamp(previousKernel, Number(customTxLifetime));
    expect(expirationTimestamp).toBe(blockTimestamp + customTxLifetime - 1n);
  });

  it('throws if custom tx lifetime is greater than the max allowed', () => {
    const customTxLifetime = maxTxLifetime + 1n;
    expect(() => computeTxExpirationTimestamp(previousKernel, Number(customTxLifetime))).toThrow();
  });
});
