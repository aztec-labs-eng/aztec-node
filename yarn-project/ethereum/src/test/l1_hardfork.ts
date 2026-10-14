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
 * Returns a describe block name with the L1 hardfork from `$ANVIL_HARDFORK` appended, e.g. `Registry (amsterdam)`, so
 * test output and reports show which fork a run used. Returns the name unchanged when `$ANVIL_HARDFORK` is unset.
 */
export function describeNameOnL1Fork(name: string): string {
  const hardfork = getL1Hardfork();
  return hardfork ? `${name} (${hardfork})` : name;
}

type DescribeBlock = (name: string, fn: () => void) => void;

/**
 * A `describe` that also tags its test file for CI test-command generation, and appends the L1 hardfork to the block's
 * name when `$ANVIL_HARDFORK` is set.
 */
export type TaggedDescribe = DescribeBlock & { skip: DescribeBlock; only: DescribeBlock };

function taggedDescribe(): TaggedDescribe {
  // Jest's global `describe` is read at call time, so importing this module outside Jest stays safe.
  const tagged: TaggedDescribe = (name, fn) => describe(describeNameOnL1Fork(name), fn);
  tagged.skip = (name, fn) => describe.skip(describeNameOnL1Fork(name), fn);
  // eslint-disable-next-line no-only-tests/no-only-tests
  tagged.only = (name, fn) => describe.only(describeNameOnL1Fork(name), fn);
  return tagged;
}

/**
 * Jest's `describe`, marking the test file to also run on every other L1 hardfork on every CI run. It has no runtime
 * effect beyond `describe`: it exists so CI's test command generation (`yarn-project/scripts/echo_test_cmd.sh`)
 * can grep for it and emit one extra command per fork with `ANVIL_HARDFORK` set. So it must appear in the test file
 * itself, uncommented, not in a shared helper. A file marked with it needs no `describeWithAnvil`.
 */
export const describeAcrossL1Forks: TaggedDescribe = taggedDescribe();

/**
 * Jest's `describe`, marking a test file that starts anvil so that the full CI sweep (`CI_FULL=1` or
 * `HARDFORK_SWEEP=1`) also runs it on every other L1 hardfork. It has no runtime effect beyond `describe`: it exists
 * so CI's test command generation (`yarn-project/scripts/echo_test_cmd.sh`) can grep for it, so it must appear in
 * the test file itself, uncommented. End-to-end tests need no marker: the sweep covers every simple e2e test.
 */
export const describeWithAnvil: TaggedDescribe = taggedDescribe();
