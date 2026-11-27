import { times } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { Buffer } from 'buffer';

import { KemSharedSecret } from '../keys/kem_shared_secret.js';
import { computeHybridSharedSecret } from './shared_secret_derivation.js';

describe('computeHybridSharedSecret', () => {
  const kemSharedSecretBytes = Buffer.from(times(KemSharedSecret.SIZE_IN_BYTES, i => i + 1));
  const kemSharedSecret = KemSharedSecret.fromBuffer(kemSharedSecretBytes);
  const ecdhSharedSecret = new Point(
    Fr.fromString('0x2688431c705a5ff3e6c6f2573c9e3ba1c1026d2251d0dbbf2d810aa53fd1d186'),
    Fr.fromString('0x1e96887b117afca01c00468264f4f80b5bb16d94c1808a448595f115556e5c8e'),
  );

  // aztec-nr derives the sender's side in Noir, whose tests pin the same value for the same inputs.
  it('matches the aztec-nr derivation', async () => {
    expect(await computeHybridSharedSecret(kemSharedSecret, ecdhSharedSecret)).toEqual(
      Fr.fromString('0x005544c74008185bb962f33f0d622977d48e33c73f1227283fe7ac4ee736d76f'),
    );
  });

  // The first 31 bytes and the last byte are hashed as separate fields.
  it.each([0, 30, 31])('depends on byte %i of the KEM shared secret', async index => {
    const otherKemSharedSecretBytes = Buffer.from(kemSharedSecretBytes);
    otherKemSharedSecretBytes[index] ^= 1;

    expect(
      await computeHybridSharedSecret(KemSharedSecret.fromBuffer(otherKemSharedSecretBytes), ecdhSharedSecret),
    ).not.toEqual(await computeHybridSharedSecret(kemSharedSecret, ecdhSharedSecret));
  });
});
