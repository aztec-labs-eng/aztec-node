const KNOWN_L1_HARDFORKS = ['osaka', 'amsterdam'] as const;

/** An L1 hardfork that test anvils can be started on. */
export type L1Hardfork = (typeof KNOWN_L1_HARDFORKS)[number];

/**
 * Returns the L1 hardfork that test anvils start on, read from `$ANVIL_HARDFORK`, or undefined when it is unset.
 * Throws on a name outside the known forks, so a typo fails at once instead of after anvil's spawn retries.
 */
export function getL1Hardfork(): L1Hardfork | undefined {
  const value = process.env.ANVIL_HARDFORK?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (!(KNOWN_L1_HARDFORKS as readonly string[]).includes(value)) {
    throw new Error(`Unknown ANVIL_HARDFORK '${value}', expected one of: ${KNOWN_L1_HARDFORKS.join(', ')}`);
  }
  return value as L1Hardfork;
}

/**
 * Returns whether this test run starts its anvils on Amsterdam. This is the intended fork, not an observation:
 * a test whose chain changes fork mid-run must ask the chain (`isAmsterdamBlock`) instead.
 */
export function isAmsterdamTestRun(): boolean {
  return getL1Hardfork() === 'amsterdam';
}

/**
 * Marks the calling test file to run against every L1 hardfork on every CI run, rather than only on the full CI
 * sweep. It has no effect at runtime: CI's test command generation greps test files for a top-level call to this
 * function and emits one extra command per fork, with `ANVIL_HARDFORK` set. So the call must sit in the test file
 * itself, uncommented, not in a shared helper.
 *
 * @returns The fork this run's anvils start on, as {@link getL1Hardfork}.
 */
export function runOnAllL1Forks(): L1Hardfork | undefined {
  return getL1Hardfork();
}
