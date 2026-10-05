import { deriveBlsPrivateKey } from '@aztec-labs/foundation/crypto/bls';
import { computeBn254RegistrationDigestForPrivateKey } from '@aztec-labs/foundation/crypto/bn254';
import type { Hex } from '@aztec-labs/foundation/string';

/**
 * Upper-bound model of the minimum gas stipend `Bn254LibWrapper.proofOfPossession` needs to accept a valid key, as a
 * function of the `hashToPoint` loop work for that key:
 * `fixed + perAttempt * attempts + perSqrtCall * sqrtCalls + ceil(memoryNumerator * attempts^2 / memoryDenominator)`.
 */
export type ProofOfPossessionGasModel = {
  /** Work that does not depend on the key: pairing, scalar multiplications, hashing, stipend headroom. */
  fixed: number;
  /** Per loop attempt: keccak, ABI encoding and loop overhead. */
  perAttempt: number;
  /** Per attempt that reaches the modexp square root. */
  perSqrtCall: number;
  /** Memory growth from allocations that every attempt leaves behind, quadratic in the attempts. */
  memoryNumerator: number;
  memoryDenominator: number;
};

/** What a BLS key derivation version checks: a key fits if its estimated minimum stipend is at most `budget`. */
export type BlsKeyDerivationVersion = {
  version: number;
  gasModel: ProofOfPossessionGasModel;
  budget: number;
};

/**
 * BLS key derivation v6. The gas model is the conservative min-stipend fit of the BN254 proof-of-possession gas
 * calibration vectors measured under amsterdam pricing (aztec-packages `l1-contracts/test/fixtures/`, copied verbatim to
 * `fixtures/bn254_pop_gas_vectors.json` next to this file). The budget is the 250,000 gas default
 * `proofOfPossessionGasLimit` minus a 10% margin.
 *
 * With per-attempt probabilities 0.189030554816 of reaching the square root and 0.094515277408 of succeeding, about
 * 3.2925e-4 of keys (1 in 3,037) estimate over the budget, so they move to a later candidate under v6.
 *
 * Frozen once a CLI release ships it: changing any value changes which BLS key `--bls-key-derivation=v6` selects for
 * the same mnemonic and indices, so operators could no longer regenerate their keys. Add a new version instead.
 */
export const BLS_KEY_DERIVATION_V6: BlsKeyDerivationVersion = {
  version: 6,
  gasModel: {
    fixed: 132_694,
    perAttempt: 515,
    perSqrtCall: 4_580,
    memoryNumerator: 95_975,
    memoryDenominator: 1_000_000,
  },
  budget: 225_000,
};

/** Newest BLS key derivation version this CLI knows. Versions above it are rejected. */
export const LATEST_BLS_KEY_DERIVATION = BLS_KEY_DERIVATION_V6;

/** Number of candidates tried per validator before key selection gives up. */
export const MAX_BLS_KEY_CANDIDATES = 256;

/**
 * How a validator's BLS key is chosen among its candidates.
 * - `check`: candidate 0, failing if it estimates over the version's budget (no flags given).
 * - `retry`: the first candidate within the version's budget.
 * - `none`: candidate 0, unchecked (a version below v6, or the gas check skipped).
 */
export type BlsKeyDerivationPolicy =
  | { mode: 'check'; version: BlsKeyDerivationVersion }
  | { mode: 'retry'; version: BlsKeyDerivationVersion }
  | { mode: 'none' };

/** CLI options that choose the BLS key derivation policy. */
export type BlsKeyDerivationOptions = {
  blsKeyDerivation?: string;
  skipBlsKeyGasCheck?: boolean;
};

/** A BLS key chosen for a validator, with the derivation path and candidate that produced it. */
export type SelectedBlsKey = {
  privateKey: Hex<32>;
  /** Full derivation path, including the candidate component when the candidate is not 0. */
  path: string;
  candidate: number;
};

/** Estimated minimum stipend for the proof-of-possession check of a key with the given `hashToPoint` work. */
export function estimateProofOfPossessionGas(model: ProofOfPossessionGasModel, attempts: number, sqrtCalls: number) {
  const memory = BigInt(model.memoryNumerator) * BigInt(attempts) ** 2n;
  const denominator = BigInt(model.memoryDenominator);
  return (
    model.fixed +
    model.perAttempt * attempts +
    model.perSqrtCall * sqrtCalls +
    Number((memory + denominator - 1n) / denominator)
  );
}

/** Estimated minimum stipend for the proof-of-possession check of a BN254 BLS private key. */
export function estimateBlsKeyProofOfPossessionGas(model: ProofOfPossessionGasModel, privateKey: string) {
  const { attempts, sqrtCalls } = computeBn254RegistrationDigestForPrivateKey(privateKey);
  return estimateProofOfPossessionGas(model, attempts, sqrtCalls);
}

/** Thrown when candidate 0 estimates over the latest version's budget and no flag says what to do about it. */
export class BlsKeyOverGasBudgetError extends Error {
  constructor(
    public readonly path: string,
    public readonly estimatedGas: number,
    public readonly version: BlsKeyDerivationVersion,
    mnemonicGenerated: boolean,
  ) {
    super(
      `The proof-of-possession check of the BLS key derived at ${path} is estimated at ${estimatedGas} gas, above ` +
        `the ${version.budget} budget of BLS key derivation v${version.version}, so it could exceed the L1 gas cap. ` +
        `Re-run with --bls-key-derivation=v${version.version} to select a cheaper key for this validator, or with ` +
        `--skip-bls-key-gas-check to keep this key regardless (for example, a key already registered).` +
        (mnemonicGenerated
          ? ' This run generated its mnemonic, and re-running without --mnemonic generates a new one: to keep this ' +
            'mnemonic, pass it back with --mnemonic.'
          : ''),
    );
    this.name = 'BlsKeyOverGasBudgetError';
  }
}

/** Validates the BLS key derivation flags and turns them into a policy. */
export function resolveBlsKeyDerivationPolicy(options: BlsKeyDerivationOptions): BlsKeyDerivationPolicy {
  const { blsKeyDerivation, skipBlsKeyGasCheck } = options;
  if (blsKeyDerivation !== undefined && skipBlsKeyGasCheck) {
    throw new Error('--bls-key-derivation and --skip-bls-key-gas-check cannot be used together');
  }
  if (skipBlsKeyGasCheck) {
    return { mode: 'none' };
  }
  if (blsKeyDerivation !== undefined) {
    const version = parseBlsKeyDerivationVersion(blsKeyDerivation);
    return version < BLS_KEY_DERIVATION_V6.version
      ? { mode: 'none' }
      : { mode: 'retry', version: BLS_KEY_DERIVATION_V6 };
  }
  return { mode: 'check', version: LATEST_BLS_KEY_DERIVATION };
}

function parseBlsKeyDerivationVersion(version: string): number {
  const match = /^v([1-9][0-9]*)$/.exec(version);
  const versionNumber = match ? Number(match[1]) : undefined;
  if (versionNumber === undefined || versionNumber > LATEST_BLS_KEY_DERIVATION.version) {
    throw new Error(
      `Unknown BLS key derivation version '${version}'. Supported versions are v1 to v${LATEST_BLS_KEY_DERIVATION.version}.`,
    );
  }
  return versionNumber;
}

/** Derivation path of a candidate: candidate 0 is the per-validator path itself, others append `/<candidate>`. */
export function blsCandidatePath(perValidatorPath: string, candidate: number): string {
  return candidate === 0 ? perValidatorPath : `${perValidatorPath}/${candidate}`;
}

/** Inputs to {@link selectBlsKey}. */
export type SelectBlsKeyInput = {
  mnemonic?: string;
  ikm?: string;
  perValidatorPath: string;
  /** Whether the CLI generated the mnemonic in this run, to tell the operator how to keep it on error. */
  mnemonicGenerated?: boolean;
  maxCandidates?: number;
};

/**
 * Derives a validator's BLS key from `perValidatorPath` under the given policy. Only the mnemonic or IKM, the path
 * and the policy decide the result, so re-running with the same inputs regenerates the same key.
 */
export function selectBlsKey(policy: BlsKeyDerivationPolicy, input: SelectBlsKeyInput): SelectedBlsKey {
  const { mnemonic, ikm, perValidatorPath, mnemonicGenerated = false, maxCandidates = MAX_BLS_KEY_CANDIDATES } = input;
  const candidate0 = { privateKey: deriveBlsPrivateKey(mnemonic, ikm, perValidatorPath), path: perValidatorPath };
  if (policy.mode === 'none') {
    return { ...candidate0, candidate: 0 };
  }

  const { gasModel, budget } = policy.version;
  if (policy.mode === 'check') {
    const estimatedGas = estimateBlsKeyProofOfPossessionGas(gasModel, candidate0.privateKey);
    if (estimatedGas > budget) {
      throw new BlsKeyOverGasBudgetError(perValidatorPath, estimatedGas, policy.version, mnemonicGenerated);
    }
    return { ...candidate0, candidate: 0 };
  }

  for (let candidate = 0; candidate < maxCandidates; candidate++) {
    const path = blsCandidatePath(perValidatorPath, candidate);
    const privateKey = candidate === 0 ? candidate0.privateKey : deriveBlsPrivateKey(mnemonic, ikm, path);
    if (estimateBlsKeyProofOfPossessionGas(gasModel, privateKey) <= budget) {
      return { privateKey, path, candidate };
    }
  }
  throw new Error(
    `No BLS key within the ${budget} gas budget of BLS key derivation v${policy.version.version} found for ` +
      `${perValidatorPath} after ${maxCandidates} candidates.`,
  );
}
