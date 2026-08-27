import { Grumpkin } from '@aztec-labs/foundation/crypto/grumpkin';
import type { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';
import type { PublicKey } from '@aztec-labs/stdlib/keys';

/**
 * Method for generating a public grumpkin key from a private key.
 * @param privateKey - The private key.
 * @returns The generated public key.
 */
export function generatePublicKey(privateKey: GrumpkinScalar): Promise<PublicKey> {
  return Grumpkin.mul(Grumpkin.generator, privateKey);
}
