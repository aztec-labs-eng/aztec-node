import { Fr } from '../curves/bn254/field.js';
import { makePoseidonMerkleHash } from './hasher.js';
import { makePoseidonMerkleHashSync } from './sync.js';

describe('makePoseidonMerkleHashSync', () => {
  it('matches asynchronous hashing for concurrent initialization and different separators', async () => {
    const left = new Uint8Array(new Fr(123).toBuffer());
    const right = new Uint8Array(new Fr(456).toBuffer());
    const separators = [1, 2982624097];
    const hashers = await Promise.all(separators.map(makePoseidonMerkleHashSync));

    for (const [index, hash] of hashers.entries()) {
      const result = hash(left, right);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(await makePoseidonMerkleHash(separators[index])(Buffer.from(left), Buffer.from(right)));
    }
    expect(hashers[0](left, right)).not.toEqual(hashers[1](left, right));
  });
});
