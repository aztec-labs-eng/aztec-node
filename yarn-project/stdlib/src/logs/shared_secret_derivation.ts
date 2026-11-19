import { DomainSeparator } from '@aztec-labs/constants';
import { Grumpkin } from '@aztec-labs/foundation/crypto/grumpkin';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import type { Fq, Fr } from '@aztec-labs/foundation/curves/bn254';
import { GrumpkinScalar, type Point } from '@aztec-labs/foundation/curves/grumpkin';

import { bufferToFieldChunks } from '../abi/buffer.js';
import type { AztecAddress } from '../aztec-address/index.js';
import type { CompleteAddress } from '../contract/complete_address.js';
import { computeAddressSecret, computePreaddress } from '../keys/derivation.js';
import { KEM_SHARED_SECRET_SIZE_IN_BYTES } from '../keys/ml_kem.js';
import type { PublicKey } from '../keys/public_key.js';

/** Domain separator for hybrid shared secrets. Mirrors the separator of the same name in aztec-nr. */
const DOM_SEP__HYBRID_SHARED_SECRET = 2111733946;

/**
 * Domain separator for the messaging secrets derived from hybrid shared secrets. Mirrors the separator of the same
 * name in aztec-nr.
 */
const DOM_SEP__HYBRID_MESSAGING_SECRET = 3760126800;

/**
 * Derives the raw ECDH shared secret point `S = secretKey * publicKey`.
 *
 * @throws If the publicKey is zero.
 */
export function deriveEcdhSharedSecretPoint(secretKey: GrumpkinScalar, publicKey: PublicKey): Promise<Point> {
  if (publicKey.isZero()) {
    throw new Error(
      `Attempting to derive a shared secret with a zero public key. You have probably passed a zero public key in your Noir code somewhere thinking that the note won't be broadcast... but it was.`,
    );
  }
  return Grumpkin.mul(publicKey, secretKey);
}

/**
 * Computes the shared secret point between a local address (i.e. one for which the privacy keys are known) and
 * an external one via a Diffie-Hellman key exchange.
 *
 * Returns undefined if `externalAddress` is an invalid address.
 */
export async function computeAddressDerivedSharedSecretPoint(
  localAddress: CompleteAddress,
  localIvsk: Fq,
  externalAddress: AztecAddress,
): Promise<Point | undefined> {
  // An invalid address has no corresponding address point
  if (!(await externalAddress.isValid())) {
    return undefined;
  }

  const externalAddressPoint = await externalAddress.toAddressPoint();

  const localPreaddress = await computePreaddress(await localAddress.publicKeys.hash(), localAddress.partialAddress);
  const localAddressSecret = await computeAddressSecret(localPreaddress, localIvsk);

  // For a given local address A and external address B, the shared secret point S is (h_A + ivsk_A) * Addr_Point_B
  // (conceptually, in reality we don't use h_A + ivsk_A directly but rather the actual address secret, which is the
  // same but with an optional sign adjustment to prevent A's address point from having a negative y-coordinate).
  return Grumpkin.mul(externalAddressPoint, localAddressSecret);
}

/** @deprecated Use {@link computeAddressDerivedSharedSecretPoint}. */
export const computeSharedTaggingSecret = computeAddressDerivedSharedSecretPoint;

/**
 * Combines a KEM shared secret with an ECDH shared secret.
 *
 * The resulting hybrid shared secret is secret for as long as either of the two is. It is
 * `h(DOM_SEP__HYBRID_SHARED_SECRET, kemSharedSecret, S.x, S.y)`, with the KEM shared secret hashed as 31-byte chunks.
 *
 * Mirrors `compute_hybrid_shared_secret` in aztec-nr.
 *
 * @throws If `kemSharedSecret` is not {@link KEM_SHARED_SECRET_SIZE_IN_BYTES} bytes long.
 */
export function computeHybridSharedSecret(kemSharedSecret: Buffer, ecdhSharedSecret: Point): Promise<Fr> {
  if (kemSharedSecret.length !== KEM_SHARED_SECRET_SIZE_IN_BYTES) {
    throw new Error(
      `A KEM shared secret is ${KEM_SHARED_SECRET_SIZE_IN_BYTES} bytes long, got ${kemSharedSecret.length} bytes`,
    );
  }
  return poseidon2HashWithSeparator(
    [...bufferToFieldChunks(kemSharedSecret), ecdhSharedSecret.x, ecdhSharedSecret.y],
    DOM_SEP__HYBRID_SHARED_SECRET,
  );
}

/**
 * Derives `app`'s messaging secret from a hybrid shared secret.
 *
 * It is `h(DOM_SEP__HYBRID_MESSAGING_SECRET, hybridSharedSecret, app)`, which reveals neither the hybrid shared secret
 * nor the messaging secret of any other contract.
 *
 * Mirrors `compute_hybrid_messaging_secret` in aztec-nr.
 */
export function computeHybridMessagingSecret(hybridSharedSecret: Fr, app: AztecAddress): Promise<Fr> {
  return poseidon2HashWithSeparator([hybridSharedSecret, app], DOM_SEP__HYBRID_MESSAGING_SECRET);
}

/**
 * Protects a handshake's shared secret from being forged by the recipient: `S' = hash(ephPk, recipientPoint) * S`.
 *
 * Mirrors aztec-nr's `protect_from_forgery` and must stay byte-compatible with it.
 *
 * @param secret - The raw shared secret `S` to protect.
 * @param ephPk - The handshake's ephemeral public key.
 * @param recipientPoint - The recipient's address point.
 */
export async function protectFromForgery(secret: Point, ephPk: Point, recipientPoint: Point): Promise<Point> {
  const scalar = await poseidon2HashWithSeparator(
    [ephPk.x, ephPk.y, recipientPoint.x, recipientPoint.y],
    DomainSeparator.HANDSHAKE_FORGERY_PROTECTION,
  );
  return Grumpkin.mul(secret, new GrumpkinScalar(scalar.toBigInt()));
}
