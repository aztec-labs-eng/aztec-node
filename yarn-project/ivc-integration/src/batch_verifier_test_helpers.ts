import { BatchChonkVerifier } from '@aztec-labs/bb-prover';
import { toBigIntBE, toBufferBE } from '@aztec-labs/foundation/bigint-buffer';
import { Fq } from '@aztec-labs/foundation/curves/bn254';
import type { IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';
import { Buffer } from 'buffer';

/** Corrupt flat proof fields by flipping bytes in an early field element. */
export function corruptProofFields(fields: Uint8Array[]): Uint8Array[] {
  const corrupted = fields.map(f => Uint8Array.from(f));
  corrupted[2] = Uint8Array.from(corrupted[2]);
  corrupted[2][30] ^= 0xff;
  corrupted[2][31] ^= 0xff;
  return corrupted;
}

/** bb encodes a base-field coordinate as two fields: the low 136 bits, then the rest. */
const FQ_LO_BITS = 136n;
/** The point (1, 1) in bb's encoding: off the curve, since 1 ≠ 1 + 3, with canonical coordinates. */
const OFF_CURVE_POINT = [1n, 0n, 1n, 0n];

function isOnCurve(x: bigint, y: bigint): boolean {
  const q = Fq.MODULUS;
  return (y * y) % q === (((x * x) % q) * x + 3n) % q;
}

/**
 * Replaces the first bn254 commitment in the proof with a point off the curve. bb throws while deserializing such a
 * point, so this is a malformed proof rather than one that fails a check.
 */
export function offCurveProofFields(fields: Uint8Array[]): Uint8Array[] {
  const values = fields.map(f => toBigIntBE(Buffer.from(f)));
  for (let i = 0; i + 4 <= values.length; i++) {
    const [xLo, xHi, yLo, yHi] = values.slice(i, i + 4);
    if (xLo >> FQ_LO_BITS !== 0n || yLo >> FQ_LO_BITS !== 0n) {
      continue;
    }
    const x = xLo + (xHi << FQ_LO_BITS);
    const y = yLo + (yHi << FQ_LO_BITS);
    if (x === 0n || x >= Fq.MODULUS || y >= Fq.MODULUS || !isOnCurve(x, y)) {
      continue;
    }
    return [...fields.slice(0, i), ...OFF_CURVE_POINT.map(v => toBufferBE(v, 32)), ...fields.slice(i + 4)];
  }
  throw new Error('No bn254 commitment found in the proof');
}

/** Create a BatchChonkVerifier, enqueue proofs, collect results, and stop. */
export async function runBatchVerifier(opts: {
  vks: Uint8Array[];
  numCores: number;
  batchSize: number;
  proofs: { vkIndex: number; proofFields: Uint8Array[] }[];
}): Promise<IVCProofVerificationResult[]> {
  const verifier = await BatchChonkVerifier.newForTesting(
    { bbChonkVerifyConcurrency: opts.numCores },
    opts.vks,
    opts.batchSize,
  );

  try {
    const promises = opts.proofs.map(p => verifier.enqueueProof(p.vkIndex, p.proofFields));
    return await Promise.all(promises);
  } finally {
    await verifier.stop();
  }
}
