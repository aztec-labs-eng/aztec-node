import { randomBytes } from '@aztec-labs/foundation/crypto/random';

import { KemSharedSecret } from './kem_shared_secret.js';

describe('KemSharedSecret', () => {
  it.each([KemSharedSecret.SIZE_IN_BYTES - 1, KemSharedSecret.SIZE_IN_BYTES + 1, 0])(
    'rejects a %i-byte buffer',
    length => {
      expect(() => KemSharedSecret.fromBuffer(randomBytes(length))).toThrow(`got ${length} bytes`);
    },
  );
});
