import { bn254 } from '@noble/curves/bn254';

import { toBigIntBE, toBufferBE } from '../../bigint-buffer/index.js';
import { keccak256 } from '../keccak/index.js';

/** `BN254Lib.STAKING_DOMAIN_SEPARATOR`: `bytes32("AZTEC_BLS_POP_BN254_V1")`, left-aligned and zero-padded. */
export const BN254_STAKING_DOMAIN_SEPARATOR: Buffer = Buffer.concat([
  Buffer.from('AZTEC_BLS_POP_BN254_V1', 'utf8'),
  Buffer.alloc(32 - 'AZTEC_BLS_POP_BN254_V1'.length),
]);

const Fp = bn254.fields.Fp;
const BASE_FIELD_ORDER = Fp.ORDER;
const SQRT_EXPONENT = (BASE_FIELD_ORDER + 1n) / 4n;
const UINT256_MAX = (1n << 256n) - 1n;

/** Result of {@link bn254HashToPoint}, with the work the L1 loop performs to reach it. */
export type Bn254HashToPointResult = {
  /** The G1 point in affine coordinates. */
  point: { x: bigint; y: bigint };
  /** Loop attempts, each one a keccak over `(domain, message, attempt)`. */
  attempts: number;
  /** Attempts whose candidate was below the base field order and so reached the modexp square root. */
  sqrtCalls: number;
};

/**
 * Port of `BN254Lib.hashToPoint` from the L1 contracts. It must stay bit-for-bit identical to the Solidity
 * implementation, including its rejection-sampling loop and root choice, since the result is what a proof of
 * possession signs and the attempt count drives the L1 verification gas.
 */
export function bn254HashToPoint(domain: Buffer, message: Buffer): Bn254HashToPointResult {
  if (domain.length !== 32) {
    throw new Error(`Domain must be 32 bytes, got ${domain.length}`);
  }
  let attempts = 0;
  let sqrtCalls = 0;
  while (true) {
    const x = toBigIntBE(keccak256(abiEncodeHashInput(domain, message, BigInt(attempts))));
    attempts++;

    if (x >= BASE_FIELD_ORDER) {
      continue;
    }

    const yy = Fp.add(Fp.mul(Fp.mul(x, x), x), 3n);
    sqrtCalls++;
    const y = Fp.pow(yy, SQRT_EXPONENT);
    if (Fp.mul(y, y) !== yy) {
      continue;
    }

    let y0 = y;
    let y1 = BASE_FIELD_ORDER - y;
    if (y0 > y1) {
      [y0, y1] = [y1, y0];
    }
    const b = toBigIntBE(keccak256(abiEncodeHashInput(domain, message, UINT256_MAX)));
    return { point: { x, y: (b & 1n) === 0n ? y0 : y1 }, attempts, sqrtCalls };
  }
}

/**
 * Port of `BN254Lib.g1ToDigestPoint`, which GSE exposes as `getRegistrationDigest`: the point a BLS key signs to
 * prove possession of the key, derived from the affine G1 public key.
 */
export function computeBn254RegistrationDigest(publicKeyG1: { x: bigint; y: bigint }): Bn254HashToPointResult {
  return bn254HashToPoint(
    BN254_STAKING_DOMAIN_SEPARATOR,
    Buffer.concat([toUint256(publicKeyG1.x), toUint256(publicKeyG1.y)]),
  );
}

/** Computes the registration digest of the G1 public key of a BN254 BLS private key. */
export function computeBn254RegistrationDigestForPrivateKey(privateKeyHex: string): Bn254HashToPointResult {
  const sk = BigInt(privateKeyHex) % bn254.fields.Fr.ORDER;
  const publicKey = bn254.G1.ProjectivePoint.BASE.multiply(sk).toAffine();
  return computeBn254RegistrationDigest(publicKey);
}

/** Solidity `abi.encode(bytes32 domain, bytes message, uint256 counter)`. */
function abiEncodeHashInput(domain: Buffer, message: Buffer, counter: bigint): Buffer {
  const paddedMessageLength = Math.ceil(message.length / 32) * 32;
  const out = Buffer.alloc(128 + paddedMessageLength);
  domain.copy(out, 0);
  toUint256(96n).copy(out, 32);
  toUint256(counter).copy(out, 64);
  toUint256(BigInt(message.length)).copy(out, 96);
  message.copy(out, 128);
  return out;
}

function toUint256(value: bigint): Buffer {
  return toBufferBE(value, 32);
}
