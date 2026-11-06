import { DomainSeparator } from '@aztec-labs/constants';
import { Grumpkin } from '@aztec-labs/foundation/crypto/grumpkin';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { sha512, sha512ToGrumpkinScalar } from '@aztec-labs/foundation/crypto/sha512';
import { Fq, Fr } from '@aztec-labs/foundation/curves/bn254';
import { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';
import { serializeToBuffer } from '@aztec-labs/foundation/serialize';
import { ml_kem768 as mlKem768 } from '@noble/post-quantum/ml-kem';
import { Buffer } from 'buffer';

import { AztecAddress } from '../aztec-address/index.js';
import type { KeyPrefix } from './key_types.js';
import { PostQuantumPublicKey } from './post_quantum_public_key.js';
import { PublicKey, hashPublicKey } from './public_key.js';
import { PublicKeys } from './public_keys.js';
import { getKeyGenerator } from './utils.js';

/**
 * Domain separator for the seed of an account's post-quantum key pair, derived from its name like every domain
 * separator.
 */
const DOM_SEP__POST_QUANTUM_KEY_PAIR_SEED = 3053071212;

export function computeAppNullifierHidingKey(
  masterNullifierHidingSecretKey: GrumpkinScalar,
  app: AztecAddress,
): Promise<Fr> {
  return computeAppSecretKey(masterNullifierHidingSecretKey, app, 'n'); // 'n' is the key prefix for nullifier hiding key
}

/** Derives the tagging secret key `app` gets from an account's master tagging secret key. */
export function computeAppTaggingSecretKey(masterTaggingSecretKey: GrumpkinScalar, app: AztecAddress): Promise<Fr> {
  return computeAppSecretKey(masterTaggingSecretKey, app, 't'); // 't' is the key prefix for the tagging key
}

export function computeAppSecretKey(skM: GrumpkinScalar, app: AztecAddress, keyPrefix: KeyPrefix): Promise<Fr> {
  const generator = getKeyGenerator(keyPrefix);
  return poseidon2HashWithSeparator([skM.hi, skM.lo, app], generator);
}

export async function computeOvskApp(ovsk: GrumpkinScalar, app: AztecAddress): Promise<Fq> {
  const ovskAppFr = await computeAppSecretKey(ovsk, app, 'ov'); // 'ov' is the key prefix for outgoing viewing key
  // Here we are intentionally converting Fr (output of poseidon) to Fq. This is fine even though a distribution of
  // P = s * G will not be uniform because 2 * (q - r) / q is small.
  return GrumpkinScalar.fromBuffer(ovskAppFr.toBuffer());
}

export function deriveMasterNullifierHidingSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, DomainSeparator.NHK_M]);
}

export function deriveMasterIncomingViewingSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, DomainSeparator.IVSK_M]);
}

export function deriveMasterOutgoingViewingSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, DomainSeparator.OVSK_M]);
}

export function deriveMasterMessageSigningSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, DomainSeparator.MSSK_M]);
}

export function deriveMasterFallbackSecretKey(secretKey: Fr): GrumpkinScalar {
  return sha512ToGrumpkinScalar([secretKey, DomainSeparator.FBSK_M]);
}

/**
 * Derives an account's post-quantum key pair, an ML-KEM-768 one, from its master tagging secret key.
 *
 * The pair is deterministic, so it needs no backup: anyone holding the account's privacy keys derives the same pair.
 */
export function derivePostQuantumKeyPair(masterTaggingSecretKey: GrumpkinScalar): {
  publicKey: PostQuantumPublicKey;
  secretKey: Buffer;
} {
  // TODO(F-961): handle this pair like the other master keys: with wallets deriving it as they see fit (e.g. from the
  // account's secret key) and then handing it to PXE's key store. It is derived from `tsk_m` for now because PXE
  // already holds every account's `tsk_m`, so it can derive any account's pair itself, including accounts in stores
  // written by earlier PXE versions (before this key existed), with no store migration. The derivation is safe, since
  // `tpk_m` is only ever shared as a hash and so a post-quantum attacker cannot recover `tsk_m`, but less flexible,
  // since wallets cannot choose how the pair is derived.
  const seed = sha512(serializeToBuffer([masterTaggingSecretKey, DOM_SEP__POST_QUANTUM_KEY_PAIR_SEED]));
  const { publicKey, secretKey } = mlKem768.keygen(seed);
  return { publicKey: PostQuantumPublicKey.fromBuffer(Buffer.from(publicKey)), secretKey: Buffer.from(secretKey) };
}

export function computePreaddress(publicKeysHash: Fr, partialAddress: Fr) {
  return poseidon2HashWithSeparator([publicKeysHash, partialAddress], DomainSeparator.CONTRACT_ADDRESS_V3);
}

export async function computeAddress(publicKeys: PublicKeys, partialAddress: Fr): Promise<AztecAddress> {
  // Given public keys and a partial address, we can compute our address in the following steps.
  // 1. preaddress = poseidon2([publicKeysHash, partialAddress], DomainSeparator.CONTRACT_ADDRESS_V3);
  // 2. addressPoint = (preaddress * G) + ivpk_m
  // 3. address = addressPoint.x
  const preaddress = await computePreaddress(await publicKeys.hash(), partialAddress);
  const address = await Grumpkin.add(
    await derivePublicKeyFromSecretKey(new Fq(preaddress.toBigInt())),
    publicKeys.ivpkM,
  );

  return new AztecAddress(address.x);
}

export async function computeAddressSecret(preaddress: Fr, ivsk: Fq) {
  // TLDR; P1 = (h + ivsk) * G
  // if P1.y is pos
  //   S = (h + ivsk)
  // else
  //   S = Fq.MODULUS - (h + ivsk)
  //
  // Given h (our preaddress) and our ivsk, we have two different addressSecret candidates. One encodes to a point with a positive y-coordinate
  // and the other encodes to a point with a negative y-coordinate. We take the addressSecret candidate that is a simple addition of the two Scalars.
  const addressSecretCandidate = ivsk.add(new Fq(preaddress.toBigInt()));
  // We then multiply this secretCandidate by the generator G to create an addressPoint candidate.
  const addressPointCandidate = await derivePublicKeyFromSecretKey(addressSecretCandidate);

  // Because all encryption to addresses is done using a point with the positive y-coordinate, if our addressSecret candidate derives a point with a
  // negative y-coordinate, we use the other candidate by negating the secret. This transformation of the secret simply flips the y-coordinate of the derived point while keeping the x-coordinate the same.
  if (!(addressPointCandidate.y.toBigInt() <= (Fr.MODULUS - 1n) / 2n)) {
    return new Fq(Fq.MODULUS - addressSecretCandidate.toBigInt());
  }

  return addressSecretCandidate;
}

export function derivePublicKeyFromSecretKey(secretKey: Fq): Promise<PublicKey> {
  // 0 * G is the point at infinity. The WASM encodes infinity with an out-of-field x coordinate that Point cannot
  // deserialize, so return the point directly instead of calling into it.
  if (secretKey.isZero()) {
    return Promise.resolve(PublicKey.INFINITY);
  }
  return Grumpkin.mul(Grumpkin.generator, secretKey);
}

/**
 * The six master secret keys that fully define an account's privacy keys.
 */
export type MasterSecretKeys = {
  masterNullifierHidingSecretKey: GrumpkinScalar;
  masterIncomingViewingSecretKey: GrumpkinScalar;
  masterOutgoingViewingSecretKey: GrumpkinScalar;
  masterTaggingSecretKey: GrumpkinScalar;
  masterMessageSigningSecretKey: GrumpkinScalar;
  masterFallbackSecretKey: GrumpkinScalar;
};

/**
 * Computes secret and public keys and public keys hash from a secret key.
 * @param secretKey - The secret key to derive keys from.
 * @returns The derived keys.
 */
export function deriveKeys(secretKey: Fr) {
  // First we derive master secret/hiding keys -  we use sha512 here because this derivation will never take place
  // in a circuit
  return deriveKeysFromMasterSecretKeys({
    masterNullifierHidingSecretKey: deriveMasterNullifierHidingSecretKey(secretKey),
    masterIncomingViewingSecretKey: deriveMasterIncomingViewingSecretKey(secretKey),
    masterOutgoingViewingSecretKey: deriveMasterOutgoingViewingSecretKey(secretKey),
    masterTaggingSecretKey: sha512ToGrumpkinScalar([secretKey, DomainSeparator.TSK_M]),
    masterMessageSigningSecretKey: deriveMasterMessageSigningSecretKey(secretKey),
    masterFallbackSecretKey: deriveMasterFallbackSecretKey(secretKey),
  });
}

/**
 * Derives the master public keys and the {@link PublicKeys} struct from a set of master secret keys.
 * @param secretKeys - The master secret keys to derive public keys from.
 * @returns The provided secret keys alongside the derived public keys.
 */
export async function deriveKeysFromMasterSecretKeys(secretKeys: MasterSecretKeys) {
  const {
    masterNullifierHidingSecretKey,
    masterIncomingViewingSecretKey,
    masterOutgoingViewingSecretKey,
    masterTaggingSecretKey,
    masterMessageSigningSecretKey,
    masterFallbackSecretKey,
  } = secretKeys;

  const masterNullifierHidingPublicKey = await derivePublicKeyFromSecretKey(masterNullifierHidingSecretKey);
  const masterIncomingViewingPublicKey = await derivePublicKeyFromSecretKey(masterIncomingViewingSecretKey);
  const masterOutgoingViewingPublicKey = await derivePublicKeyFromSecretKey(masterOutgoingViewingSecretKey);
  const masterTaggingPublicKey = await derivePublicKeyFromSecretKey(masterTaggingSecretKey);
  const masterMessageSigningPublicKey = await derivePublicKeyFromSecretKey(masterMessageSigningSecretKey);
  const masterFallbackPublicKey = await derivePublicKeyFromSecretKey(masterFallbackSecretKey);

  // The non-owner-visible PublicKeys carries hashes for npk/ovpk/tpk/mspk/fbpk and the raw
  // point only for ivpk_m. The npk/ovpk/tpk/mspk/fbpk raw points are also returned alongside so the key
  // store can persist them under `${account}-{n|ov|t|ms|fb}pk_m` (only their hashes live in publicKeys).
  // The ivpk_m point isn't returned separately because it already lives in publicKeys.ivpkM.
  const publicKeys = new PublicKeys(
    await hashPublicKey(masterNullifierHidingPublicKey),
    masterIncomingViewingPublicKey,
    await hashPublicKey(masterOutgoingViewingPublicKey),
    await hashPublicKey(masterTaggingPublicKey),
    await hashPublicKey(masterMessageSigningPublicKey),
    await hashPublicKey(masterFallbackPublicKey),
  );

  return {
    masterNullifierHidingSecretKey,
    masterIncomingViewingSecretKey,
    masterOutgoingViewingSecretKey,
    masterTaggingSecretKey,
    masterMessageSigningSecretKey,
    masterFallbackSecretKey,
    masterNullifierHidingPublicKey,
    masterOutgoingViewingPublicKey,
    masterTaggingPublicKey,
    masterMessageSigningPublicKey,
    masterFallbackPublicKey,
    publicKeys,
  };
}
