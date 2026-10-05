import { bn254 } from '@noble/curves/bn254';

import {
  BN254_STAKING_DOMAIN_SEPARATOR,
  bn254HashToPoint,
  computeBn254RegistrationDigest,
  computeBn254RegistrationDigestForPrivateKey,
} from './hash_to_point.js';

const Fp = bn254.fields.Fp;

function isOnCurve({ x, y }: { x: bigint; y: bigint }) {
  return Fp.eql(Fp.sqr(y), Fp.add(Fp.mul(Fp.sqr(x), x), 3n));
}

function rootOf({ y }: { y: bigint }) {
  return y < Fp.ORDER - y ? 'low' : 'high';
}

describe('BN254 hashToPoint', () => {
  it('encodes the staking domain separator as a left-aligned bytes32', () => {
    expect(BN254_STAKING_DOMAIN_SEPARATOR.toString('hex')).toBe(
      '415a5445435f424c535f504f505f424e3235345f563100000000000000000000',
    );
  });

  it('needs 95 attempts and 18 square roots for sk = 57193', () => {
    const publicKey = bn254.G1.ProjectivePoint.BASE.multiply(57193n).toAffine();
    expect(publicKey.x).toBe(0x1a1383977034b577ba8926d30c99597e834be3771805097c749b29b43bdf71ccn);
    expect(publicKey.y).toBe(0x12b45210a04c9bbd925ff963f5c6338cddbaeb761955599fdee20cbdf60bff5en);

    const result = computeBn254RegistrationDigest(publicKey);
    expect(result.attempts).toBe(95);
    expect(result.sqrtCalls).toBe(18);
    expect(isOnCurve(result.point)).toBe(true);
  });

  // Each entry was checked against GSE.getRegistrationDigest in ethereum/src/contracts/gse.test.ts.
  it.each([
    { sk: 1n, attempts: 19, sqrtCalls: 2, root: 'low' },
    { sk: 2n, attempts: 2, sqrtCalls: 1, root: 'low' },
    { sk: 5n, attempts: 14, sqrtCalls: 3, root: 'high' },
    { sk: 8n, attempts: 2, sqrtCalls: 2, root: 'high' },
    { sk: 11n, attempts: 31, sqrtCalls: 3, root: 'high' },
    { sk: 12n, attempts: 1, sqrtCalls: 1, root: 'high' },
    { sk: 57193n, attempts: 95, sqrtCalls: 18, root: 'high' },
  ])('computes the digest of sk = $sk', ({ sk, attempts, sqrtCalls, root }) => {
    const result = computeBn254RegistrationDigestForPrivateKey(`0x${sk.toString(16).padStart(64, '0')}`);
    expect(result).toMatchObject({ attempts, sqrtCalls });
    expect(rootOf(result.point)).toBe(root);
    expect(isOnCurve(result.point)).toBe(true);
  });

  it('is deterministic and depends on the domain', () => {
    const message = Buffer.from('aztec');
    const domain = Buffer.alloc(32, 1);
    expect(bn254HashToPoint(domain, message)).toEqual(bn254HashToPoint(domain, message));
    expect(bn254HashToPoint(domain, message).point).not.toEqual(bn254HashToPoint(Buffer.alloc(32, 2), message).point);
  });

  it('rejects a domain that is not 32 bytes', () => {
    expect(() => bn254HashToPoint(Buffer.alloc(31), Buffer.alloc(0))).toThrow(/32 bytes/);
  });
});
