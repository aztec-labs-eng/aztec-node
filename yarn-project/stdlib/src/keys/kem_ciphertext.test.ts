import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { KemCiphertext } from './kem_ciphertext.js';

describe('KemCiphertext', () => {
  const randomCiphertext = () => KemCiphertext.fromBuffer(randomBytes(KemCiphertext.SIZE_IN_BYTES));

  it('round-trips through its field encoding', () => {
    const ciphertext = randomCiphertext();

    expect(KemCiphertext.fromFields(ciphertext.toFields()).toBuffer()).toEqual(ciphertext.toBuffer());
  });

  it.each([KemCiphertext.SIZE_IN_BYTES - 1, KemCiphertext.SIZE_IN_BYTES + 1, 0])('rejects a %i-byte buffer', length => {
    expect(() => KemCiphertext.fromBuffer(randomBytes(length))).toThrow(`got ${length} bytes`);
  });

  it('rejects fields that do not encode a ciphertext', () => {
    const fields = randomCiphertext().toFields();
    fields[0] = fields[0].add(new Fr(1n << 248n));

    expect(() => KemCiphertext.fromFields(fields)).toThrow('Field 0 ');
  });
});
