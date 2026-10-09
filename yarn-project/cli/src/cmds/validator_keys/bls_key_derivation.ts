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
 * Frozen once a CLI release ships it: changing any value changes which BLS key `--bls-key-derivation-v6` selects for
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

/** Version checked when no derivation flag is given. A future version gets its own flag next to `--bls-key-derivation-v6`. */
export const LATEST_BLS_KEY_DERIVATION = BLS_KEY_DERIVATION_V6;

/** Number of candidates tried per validator before key selection gives up. */
export const MAX_BLS_KEY_CANDIDATES = 256;

/**
 * How a validator's BLS key is chosen among its candidates. The budget is `maxGas` when set (a stricter, user-chosen
 * value), or the version's budget otherwise.
 * - `check`: candidate 0, failing if it estimates over the budget (no `--bls-key-derivation-v6`).
 * - `retry`: the first candidate within the budget (`--bls-key-derivation-v6`).
 * - `none`: candidate 0, unchecked (`--skip-bls-key-gas-check`).
 */
export type BlsKeyDerivationPolicy =
  | { mode: 'check'; version: BlsKeyDerivationVersion; maxGas?: number }
  | { mode: 'retry'; version: BlsKeyDerivationVersion; maxGas?: number }
  | { mode: 'none' };

/** CLI options that choose the BLS key derivation policy. */
export type BlsKeyDerivationOptions = {
  blsKeyDerivationV6?: boolean;
  blsKeyDerivationMaxGas?: number;
  skipBlsKeyGasCheck?: boolean;
};

/** A BLS key chosen for a validator, with the derivation path and candidate that produced it. */
export type SelectedBlsKey = {
  privateKey: Hex<32>;
  /** Full derivation path, including the candidate component when the candidate is not 0. */
  path: string;
  candidate: number;
  /** The `--bls-key-derivation-max-gas` value, when it took part in selecting a candidate other than 0. */
  maxGas?: number;
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

/** Lowest gas estimate any key can have: one attempt that reaches the square root and succeeds. */
export function minimumProofOfPossessionGas(model: ProofOfPossessionGasModel) {
  return estimateProofOfPossessionGas(model, 1, 1);
}

/** Thrown when candidate 0 estimates over the budget and no flag says what to do about it. */
export class BlsKeyOverGasBudgetError extends Error {
  constructor(
    public readonly path: string,
    public readonly estimatedGas: number,
    public readonly version: BlsKeyDerivationVersion,
    public readonly maxGas: number | undefined,
    mnemonicGenerated: boolean,
  ) {
    const budget =
      maxGas === undefined
        ? `the ${version.budget} budget of BLS key derivation v${version.version}, so it could exceed the L1 gas cap`
        : `the ${maxGas} budget set by --bls-key-derivation-max-gas`;
    const remedies =
      maxGas === undefined
        ? `Re-run with --bls-key-derivation-v${version.version} to select a cheaper key for this validator, or with ` +
          `--skip-bls-key-gas-check to keep this key regardless (for example, a key already registered).`
        : `Re-run with --bls-key-derivation-v${version.version} to select a cheaper key for this validator, or with a ` +
          `higher --bls-key-derivation-max-gas.`;
    super(
      `The proof-of-possession check of the BLS key derived at ${path} is estimated at ${estimatedGas} gas, above ` +
        `${budget}. ${remedies}` +
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
  const { blsKeyDerivationV6, blsKeyDerivationMaxGas: maxGas, skipBlsKeyGasCheck } = options;
  const version = LATEST_BLS_KEY_DERIVATION;
  if (skipBlsKeyGasCheck) {
    if (blsKeyDerivationV6) {
      throw new Error('--bls-key-derivation-v6 and --skip-bls-key-gas-check cannot be used together');
    }
    if (maxGas !== undefined) {
      throw new Error('--bls-key-derivation-max-gas and --skip-bls-key-gas-check cannot be used together');
    }
    return { mode: 'none' };
  }

  if (maxGas !== undefined) {
    if (!Number.isSafeInteger(maxGas)) {
      throw new Error(`--bls-key-derivation-max-gas must be an integer, got ${maxGas}`);
    }
    if (maxGas > version.budget) {
      throw new Error(
        `--bls-key-derivation-max-gas can only lower the budget: ${maxGas} is above the ${version.budget} gas budget ` +
          `of BLS key derivation v${version.version}.`,
      );
    }
    const minimum = minimumProofOfPossessionGas(version.gasModel);
    if (maxGas < minimum) {
      throw new Error(
        `--bls-key-derivation-max-gas ${maxGas} is below ${minimum}, the lowest proof-of-possession gas estimate any ` +
          `key can have, so no key could fit.`,
      );
    }
  }

  return { mode: blsKeyDerivationV6 ? 'retry' : 'check', version, ...(maxGas !== undefined ? { maxGas } : {}) };
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

  const { gasModel } = policy.version;
  const budget = policy.maxGas ?? policy.version.budget;
  if (policy.mode === 'check') {
    const estimatedGas = estimateBlsKeyProofOfPossessionGas(gasModel, candidate0.privateKey);
    if (estimatedGas > budget) {
      throw new BlsKeyOverGasBudgetError(
        perValidatorPath,
        estimatedGas,
        policy.version,
        policy.maxGas,
        mnemonicGenerated,
      );
    }
    return { ...candidate0, candidate: 0 };
  }

  for (let candidate = 0; candidate < maxCandidates; candidate++) {
    const path = blsCandidatePath(perValidatorPath, candidate);
    const privateKey = candidate === 0 ? candidate0.privateKey : deriveBlsPrivateKey(mnemonic, ikm, path);
    if (estimateBlsKeyProofOfPossessionGas(gasModel, privateKey) <= budget) {
      return {
        privateKey,
        path,
        candidate,
        ...(candidate > 0 && policy.maxGas !== undefined ? { maxGas: budget } : {}),
      };
    }
  }
  throw new Error(
    `No BLS key within the ${budget} gas budget found for ` + `${perValidatorPath} after ${maxCandidates} candidates.`,
  );
}
