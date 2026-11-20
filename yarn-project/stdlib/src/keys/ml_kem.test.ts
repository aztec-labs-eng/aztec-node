import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';
import { Buffer } from 'buffer';

import { derivePostQuantumKeyPair } from './derivation.js';
import { KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES, mlKemDecapsulate, mlKemEncapsulate } from './ml_kem.js';
import { PostQuantumPublicKey } from './post_quantum_public_key.js';

describe('ML-KEM', () => {
  const randomKeyPair = () => derivePostQuantumKeyPair(GrumpkinScalar.random());
  const randomSeed = () => randomBytes(KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES);

  it('decapsulates the shared secret of an encapsulation', () => {
    const { publicKey, secretKey } = randomKeyPair();

    const { sharedSecret, ciphertext } = mlKemEncapsulate(publicKey, randomSeed())!;

    expect(mlKemDecapsulate(ciphertext, secretKey)).toEqual(sharedSecret);
  });

  it('encapsulates the same shared secret and ciphertext from the same seed', () => {
    const { publicKey } = randomKeyPair();
    const seed = randomSeed();

    const encapsulation = mlKemEncapsulate(publicKey, seed)!;
    const sameEncapsulation = mlKemEncapsulate(publicKey, seed)!;

    expect(sameEncapsulation.sharedSecret).toEqual(encapsulation.sharedSecret);
    expect(sameEncapsulation.ciphertext.toBuffer()).toEqual(encapsulation.ciphertext.toBuffer());
  });

  it('encapsulates a different shared secret and ciphertext from another seed', () => {
    const { publicKey } = randomKeyPair();

    const encapsulation = mlKemEncapsulate(publicKey, randomSeed())!;
    const otherEncapsulation = mlKemEncapsulate(publicKey, randomSeed())!;

    expect(otherEncapsulation.sharedSecret).not.toEqual(encapsulation.sharedSecret);
    expect(otherEncapsulation.ciphertext.toBuffer()).not.toEqual(encapsulation.ciphertext.toBuffer());
  });

  it('decapsulates an unrelated shared secret with the secret key of another pair', () => {
    const { sharedSecret, ciphertext } = mlKemEncapsulate(randomKeyPair().publicKey, randomSeed())!;

    expect(mlKemDecapsulate(ciphertext, randomKeyPair().secretKey)).not.toEqual(sharedSecret);
  });

  it('does not encapsulate to a key with out of range coefficients', () => {
    // Every coefficient of this key is 4095, and ML-KEM-768 allows none above 3328.
    const publicKey = PostQuantumPublicKey.fromBuffer(Buffer.alloc(PostQuantumPublicKey.SIZE_IN_BYTES, 0xff));

    expect(mlKemEncapsulate(publicKey, randomSeed())).toBeUndefined();
  });

  it.each([KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES - 1, KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES + 1, 0])(
    'rejects a %i-byte seed',
    length => {
      const { publicKey } = randomKeyPair();

      expect(() => mlKemEncapsulate(publicKey, randomBytes(length))).toThrow(`got ${length} bytes`);
    },
  );
});
