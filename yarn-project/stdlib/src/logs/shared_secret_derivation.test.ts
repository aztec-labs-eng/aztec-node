import { times } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { Buffer } from 'buffer';

import { AztecAddress } from '../aztec-address/index.js';
import { KEM_SHARED_SECRET_SIZE_IN_BYTES } from '../keys/ml_kem.js';
import { computeHybridMessagingSecret, computeHybridSharedSecret } from './shared_secret_derivation.js';

describe('computeHybridSharedSecret', () => {
  // The bytes 1 to 32.
  const kemSharedSecret = Buffer.from(times(KEM_SHARED_SECRET_SIZE_IN_BYTES, i => i + 1));
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
    const otherKemSharedSecret = Buffer.from(kemSharedSecret);
    otherKemSharedSecret[index] ^= 1;

    expect(await computeHybridSharedSecret(otherKemSharedSecret, ecdhSharedSecret)).not.toEqual(
      await computeHybridSharedSecret(kemSharedSecret, ecdhSharedSecret),
    );
  });

  it('depends on both coordinates of the ECDH shared secret', async () => {
    const hybridSharedSecret = await computeHybridSharedSecret(kemSharedSecret, ecdhSharedSecret);
    const otherX = new Point(ecdhSharedSecret.x.add(Fr.ONE), ecdhSharedSecret.y);
    const otherY = new Point(ecdhSharedSecret.x, ecdhSharedSecret.y.add(Fr.ONE));

    expect(await computeHybridSharedSecret(kemSharedSecret, otherX)).not.toEqual(hybridSharedSecret);
    expect(await computeHybridSharedSecret(kemSharedSecret, otherY)).not.toEqual(hybridSharedSecret);
  });

  it.each([KEM_SHARED_SECRET_SIZE_IN_BYTES - 1, KEM_SHARED_SECRET_SIZE_IN_BYTES + 1, 0])(
    'rejects a %i-byte KEM shared secret',
    length => {
      expect(() => computeHybridSharedSecret(Buffer.alloc(length), ecdhSharedSecret)).toThrow(`got ${length} bytes`);
    },
  );
});

describe('computeHybridMessagingSecret', () => {
  const hybridSharedSecret = new Fr(7);
  const app = AztecAddress.fromNumberUnsafe(42);

  // aztec-nr derives the sender's side in Noir, whose tests pin the same value for the same inputs.
  it('matches the aztec-nr derivation', async () => {
    expect(await computeHybridMessagingSecret(hybridSharedSecret, app)).toEqual(
      Fr.fromString('0x2163cd6fceadd9f938bdb1fa6237cecf0fb8cf5ee2a2aaea150354f705754d29'),
    );
  });

  it('differs per contract', async () => {
    expect(await computeHybridMessagingSecret(hybridSharedSecret, AztecAddress.fromNumberUnsafe(43))).not.toEqual(
      await computeHybridMessagingSecret(hybridSharedSecret, app),
    );
  });

  it('differs per hybrid shared secret', async () => {
    expect(await computeHybridMessagingSecret(new Fr(8), app)).not.toEqual(
      await computeHybridMessagingSecret(hybridSharedSecret, app),
    );
  });
});
