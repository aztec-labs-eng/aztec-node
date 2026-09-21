import { Fr } from '../curves/bn254/field.js';
import { makePoseidonMerkleHash, makePoseidonMerkleHashSync } from './hasher.js';

describe('makePoseidonMerkleHashSync', () => {
  it('matches asynchronous hashing for concurrent initialization and different separators', async () => {
    const left = new Uint8Array(new Fr(123).toBuffer());
    const right = new Uint8Array(new Fr(456).toBuffer());
    const separators = [1, 2982624097];
    const hashers = separators.map(makePoseidonMerkleHashSync);
    const results = await Promise.all(hashers.map(hash => hash(left, right)));

    for (const [index, result] of results.entries()) {
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(await makePoseidonMerkleHash(separators[index])(Buffer.from(left), Buffer.from(right)));
    }
    expect(results[0]).not.toEqual(results[1]);
  });
});
