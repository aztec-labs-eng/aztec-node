import gasVectors from './fixtures/bn254_pop_gas_vectors.json' with { type: 'json' };
import { computeBn254RegistrationDigestForPrivateKey } from './hash_to_point.js';
import {
  AMSTERDAM_PROOF_OF_POSSESSION_GAS_MODEL,
  estimateBlsKeyProofOfPossessionGas,
  estimateProofOfPossessionGas,
  minimumProofOfPossessionGas,
} from './proof_of_possession_gas.js';

describe('BN254 proof-of-possession gas model', () => {
  const model = AMSTERDAM_PROOF_OF_POSSESSION_GAS_MODEL;

  it('uses the measured amsterdam min-stipend model', () => {
    const { minStipend } = gasVectors.model.amsterdam;
    expect(model).toEqual({
      fixed: minStipend.F,
      perAttempt: minStipend.A,
      perSqrtCall: minStipend.S,
      memoryNumerator: minStipend.QNumerator,
      memoryDenominator: minStipend.QDenominator,
    });
  });

  it('prices osaka like amsterdam', () => {
    expect(gasVectors.model.osaka).toEqual(gasVectors.model.amsterdam);
    for (const vector of gasVectors.vectors) {
      expect(vector.gas.osaka).toEqual(vector.gas.amsterdam);
    }
  });

  it.each(gasVectors.vectors.map(v => [v.label, v] as const))(
    'bounds the measured min stipend of %s tightly',
    (_label, vector) => {
      const digest = computeBn254RegistrationDigestForPrivateKey(vector.sk);
      expect(digest).toEqual({
        point: { x: BigInt(vector.digest.x), y: BigInt(vector.digest.y) },
        attempts: vector.attempts,
        sqrtCalls: vector.sqrtCalls,
      });

      const estimated = estimateProofOfPossessionGas(model, vector.attempts, vector.sqrtCalls);
      const measured = vector.gas.amsterdam.minStipend;
      expect(estimated).toBeGreaterThanOrEqual(measured);
      expect(estimated - measured).toBeLessThanOrEqual(200);
    },
  );

  it('rounds the memory term up', () => {
    // 0.095975 * 3^2 = 0.863775, rounded up to 1.
    expect(estimateProofOfPossessionGas(model, 3, 1)).toBe(132_694 + 3 * 515 + 4_580 + 1);
  });

  it('estimates one attempt with one square root as the minimum', () => {
    expect(minimumProofOfPossessionGas(model)).toBe(132_694 + 515 + 4_580 + 1);
  });

  it('estimates a key from its private key', () => {
    // sk = 57193 needs 95 attempts and 18 square roots.
    expect(estimateBlsKeyProofOfPossessionGas(model, `0x${(57193).toString(16).padStart(64, '0')}`)).toBe(
      estimateProofOfPossessionGas(model, 95, 18),
    );
  });
});
