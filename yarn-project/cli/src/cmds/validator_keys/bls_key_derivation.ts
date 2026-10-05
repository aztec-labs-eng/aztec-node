import { deriveBlsPrivateKey } from '@aztec-labs/foundation/crypto/bls';
import { computeBn254RegistrationDigestForPrivateKey } from '@aztec-labs/foundation/crypto/bn254';
import type { Hex } from '@aztec-labs/foundation/string';

/** Newest BLS key derivation version this CLI knows. Versions above it are rejected. */
export const LATEST_BLS_KEY_DERIVATION_VERSION = 6;

/**
 * Maximum `hashToPoint` loop attempts a BLS key may need under derivation v6. A key over this bound risks a
 * proof-of-possession check that exceeds the L1 gas cap (`proofOfPossessionGasLimit`, 250k).
 *
 * Sized from Osaka pricing: a key needing 95 attempts (18 modexp square roots) costs about 264k gas to verify, so the
 * bound sits well below it. About 1 key in 575 needs more than 64 attempts.
 * TODO: confirm against measured proof-of-possession gas before the first release that ships v6.
 *
 * Frozen once a CLI release ships with it: changing it changes which BLS key `--bls-key-derivation=v6` selects for
 * the same mnemonic and indices, so operators could no longer regenerate their keys. Use a new version instead.
 */
export const BLS_KEY_DERIVATION_V6_MAX_ITERATIONS = 64;

/**
 * Max-iterations of each built-in derivation version. Versions below v6 have no entry: they always use candidate 0.
 * Released entries are frozen, see {@link BLS_KEY_DERIVATION_V6_MAX_ITERATIONS}.
 */
const BLS_KEY_DERIVATION_MAX_ITERATIONS: Record<number, number> = {
  6: BLS_KEY_DERIVATION_V6_MAX_ITERATIONS,
};

/** Number of candidates tried per validator before key selection gives up. */
export const MAX_BLS_KEY_CANDIDATES = 256;

/**
 * How a validator's BLS key is chosen among its candidates.
 * - `check`: candidate 0, failing if it needs more than `maxIterations` attempts (no flags given).
 * - `retry`: the first candidate that needs at most `maxIterations` attempts.
 * - `none`: candidate 0, unchecked (a derivation version below v6).
 */
export type BlsKeyDerivationPolicy =
  | { mode: 'check'; maxIterations: number }
  | { mode: 'retry'; maxIterations: number }
  | { mode: 'none' };

/** CLI options that choose the BLS key derivation policy. */
export type BlsKeyDerivationOptions = {
  blsKeyDerivation?: string;
  blsKeyDerivationMaxIterations?: number;
};

/** A BLS key chosen for a validator, with the derivation path and candidate that produced it. */
export type SelectedBlsKey = {
  privateKey: Hex<32>;
  /** Full derivation path, including the candidate component when the candidate is not 0. */
  path: string;
  candidate: number;
};

/** Thrown when candidate 0 is over the max-iterations bound and no flag says what to do about it. */
export class BlsKeyOverIterationsError extends Error {
  constructor(
    public readonly path: string,
    public readonly attempts: number,
    public readonly maxIterations: number,
  ) {
    super(
      `The BLS key derived at ${path} needs ${attempts} hash-to-point iterations, above the ${maxIterations} allowed ` +
        `by BLS key derivation v${LATEST_BLS_KEY_DERIVATION_VERSION}, so its proof-of-possession check could exceed ` +
        `the L1 gas cap. Re-run with --bls-key-derivation=v${LATEST_BLS_KEY_DERIVATION_VERSION} to select a cheaper ` +
        `key for this validator, or with --bls-key-derivation=v${LATEST_BLS_KEY_DERIVATION_VERSION - 1} to keep this ` +
        `key regardless (for example, a key already registered).`,
    );
    this.name = 'BlsKeyOverIterationsError';
  }
}

/** Validates the BLS key derivation flags and turns them into a policy. */
export function resolveBlsKeyDerivationPolicy(options: BlsKeyDerivationOptions): BlsKeyDerivationPolicy {
  const { blsKeyDerivation: version, blsKeyDerivationMaxIterations: maxIterations } = options;
  if (version !== undefined && maxIterations !== undefined) {
    throw new Error('--bls-key-derivation and --bls-key-derivation-max-iterations cannot be used together');
  }

  if (maxIterations !== undefined) {
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
      throw new Error(`--bls-key-derivation-max-iterations must be an integer >= 1, got ${maxIterations}`);
    }
    return { mode: 'retry', maxIterations };
  }

  if (version !== undefined) {
    const versionNumber = parseBlsKeyDerivationVersion(version);
    const versionMaxIterations = BLS_KEY_DERIVATION_MAX_ITERATIONS[versionNumber];
    return versionMaxIterations === undefined
      ? { mode: 'none' }
      : { mode: 'retry', maxIterations: versionMaxIterations };
  }

  return { mode: 'check', maxIterations: BLS_KEY_DERIVATION_MAX_ITERATIONS[LATEST_BLS_KEY_DERIVATION_VERSION] };
}

function parseBlsKeyDerivationVersion(version: string): number {
  const match = /^v([1-9][0-9]*)$/.exec(version);
  const versionNumber = match ? Number(match[1]) : undefined;
  if (versionNumber === undefined || versionNumber > LATEST_BLS_KEY_DERIVATION_VERSION) {
    throw new Error(
      `Unknown BLS key derivation version '${version}'. Supported versions are v1 to v${LATEST_BLS_KEY_DERIVATION_VERSION}.`,
    );
  }
  return versionNumber;
}

/** Derivation path of a candidate: candidate 0 is the per-validator path itself, others append `/<candidate>`. */
export function blsCandidatePath(perValidatorPath: string, candidate: number): string {
  return candidate === 0 ? perValidatorPath : `${perValidatorPath}/${candidate}`;
}

/**
 * Derives a validator's BLS key from `perValidatorPath` under the given policy. Only the mnemonic or IKM, the path
 * and the policy decide the result, so re-running with the same inputs regenerates the same key.
 */
export function selectBlsKey(
  policy: BlsKeyDerivationPolicy,
  mnemonic: string | undefined,
  ikm: string | undefined,
  perValidatorPath: string,
  maxCandidates = MAX_BLS_KEY_CANDIDATES,
): SelectedBlsKey {
  const candidate0 = { privateKey: deriveBlsPrivateKey(mnemonic, ikm, perValidatorPath), path: perValidatorPath };
  if (policy.mode === 'none') {
    return { ...candidate0, candidate: 0 };
  }

  if (policy.mode === 'check') {
    const { attempts } = computeBn254RegistrationDigestForPrivateKey(candidate0.privateKey);
    if (attempts > policy.maxIterations) {
      throw new BlsKeyOverIterationsError(perValidatorPath, attempts, policy.maxIterations);
    }
    return { ...candidate0, candidate: 0 };
  }

  for (let candidate = 0; candidate < maxCandidates; candidate++) {
    const path = blsCandidatePath(perValidatorPath, candidate);
    const privateKey = candidate === 0 ? candidate0.privateKey : deriveBlsPrivateKey(mnemonic, ikm, path);
    if (computeBn254RegistrationDigestForPrivateKey(privateKey).attempts <= policy.maxIterations) {
      return { privateKey, path, candidate };
    }
  }
  throw new Error(
    `No BLS key within ${policy.maxIterations} hash-to-point iterations found for ${perValidatorPath} after ` +
      `${maxCandidates} candidates. Use a larger --bls-key-derivation-max-iterations.`,
  );
}
