import { computeBn254RegistrationDigestForPrivateKey } from './hash_to_point.js';

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

/**
 * Conservative min-stipend fit of the BN254 proof-of-possession gas calibration vectors measured under amsterdam
 * pricing, which matches osaka on this path. The vectors are aztec-packages `l1-contracts/test/fixtures/
 * bn254_pop_gas_vectors.json`, copied verbatim to `fixtures/` next to this file.
 */
export const AMSTERDAM_PROOF_OF_POSSESSION_GAS_MODEL: ProofOfPossessionGasModel = {
  fixed: 132_694,
  perAttempt: 515,
  perSqrtCall: 4_580,
  memoryNumerator: 95_975,
  memoryDenominator: 1_000_000,
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
