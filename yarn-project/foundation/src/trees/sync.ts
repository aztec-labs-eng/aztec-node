import { BarretenbergSync } from '@aztec-foundation/bb.js';

import { poseidon2HashWithSeparator } from '../crypto/sync/poseidon/index.js';

import type { Hasher } from './hasher.js';

/** Initializes the synchronous backend and returns a domain-separated Poseidon2 Merkle hasher. */
export async function makePoseidonMerkleHashSync(separator: number): Promise<Hasher['hash']> {
  await BarretenbergSync.initSingleton();
  return (left, right) =>
    poseidon2HashWithSeparator([Buffer.from(left), Buffer.from(right)], separator).toBuffer() as Buffer<ArrayBuffer>;
}
