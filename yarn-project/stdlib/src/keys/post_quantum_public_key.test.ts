import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { PostQuantumPublicKey } from './post_quantum_public_key.js';

describe('PostQuantumPublicKey', () => {
  const randomKey = () => PostQuantumPublicKey.fromBuffer(randomBytes(PostQuantumPublicKey.SIZE_IN_BYTES));

  it('round-trips through its field encoding', () => {
    const key = randomKey();

    expect(PostQuantumPublicKey.fromFields(key.toFields()).toBuffer()).toEqual(key.toBuffer());
  });

  it.each([PostQuantumPublicKey.SIZE_IN_BYTES - 1, PostQuantumPublicKey.SIZE_IN_BYTES + 1, 0])(
    'rejects a %i-byte buffer',
    length => {
      expect(() => PostQuantumPublicKey.fromBuffer(randomBytes(length))).toThrow(`got ${length} bytes`);
    },
  );

  it.each([PostQuantumPublicKey.SIZE_IN_FIELDS - 1, PostQuantumPublicKey.SIZE_IN_FIELDS + 1])(
    'rejects %i fields',
    count => {
      const fields = [...randomKey().toFields(), Fr.ZERO].slice(0, count);

      expect(() => PostQuantumPublicKey.fromFields(fields)).toThrow(`got ${count}`);
    },
  );

  it('rejects a field with bits above its 31-byte chunk', () => {
    const fields = randomKey().toFields();
    fields[0] = fields[0].add(new Fr(1n << 248n));

    expect(() => PostQuantumPublicKey.fromFields(fields)).toThrow('Field 0 ');
  });

  it('rejects a last field with bytes past the end of the key', () => {
    const fields = randomKey().toFields();
    const last = fields.length - 1;
    fields[last] = fields[last].add(Fr.ONE);

    expect(() => PostQuantumPublicKey.fromFields(fields)).toThrow(`Field ${last} `);
  });
});
