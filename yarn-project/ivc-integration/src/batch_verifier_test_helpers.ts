import { BatchChonkVerifier } from '@aztec-labs/bb-prover';
import type { IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';

/** Corrupt flat proof fields by flipping bytes in an early field element. */
export function corruptProofFields(fields: Uint8Array[]): Uint8Array[] {
  const corrupted = fields.map(f => Uint8Array.from(f));
  corrupted[2] = Uint8Array.from(corrupted[2]);
  corrupted[2][30] ^= 0xff;
  corrupted[2][31] ^= 0xff;
  return corrupted;
}

const BN254_FQ_MODULUS = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
/** bb encodes a base-field coordinate as two fields: the low 136 bits, then the rest. */
const FQ_LO_BITS = 136n;

function toBigInt(field: Uint8Array): bigint {
  return BigInt('0x' + Buffer.from(field).toString('hex'));
}

function toField(value: bigint): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value.toString(16).padStart(64, '0'), 'hex'));
}

function isOnCurve(x: bigint, y: bigint): boolean {
  const q = BN254_FQ_MODULUS;
  return (y * y) % q === (((x * x) % q) * x + 3n) % q;
}

/**
 * Moves the first bn254 commitment in the proof off the curve, keeping its coordinates canonical. bb throws while
 * deserializing such a point, so this is a malformed proof rather than one that fails a check.
 */
export function offCurveProofFields(fields: Uint8Array[]): Uint8Array[] {
  const values = fields.map(toBigInt);
  for (let i = 0; i + 4 <= values.length; i++) {
    const [xLo, xHi, yLo, yHi] = values.slice(i, i + 4);
    if (xLo >> FQ_LO_BITS !== 0n || yLo >> FQ_LO_BITS !== 0n) {
      continue;
    }
    const x = xLo + (xHi << FQ_LO_BITS);
    const y = yLo + (yHi << FQ_LO_BITS);
    if (x === 0n || x >= BN254_FQ_MODULUS || y >= BN254_FQ_MODULUS || !isOnCurve(x, y)) {
      continue;
    }
    const corrupted = fields.map(f => Uint8Array.from(f));
    const newYLo = yLo === 0n ? 1n : yLo - 1n;
    corrupted[i + 2] = toField(newYLo);
    if (isOnCurve(x, newYLo + (yHi << FQ_LO_BITS))) {
      throw new Error('Corrupted commitment is still on the curve');
    }
    return corrupted;
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
