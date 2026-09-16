import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';

import { AppendOnlyTreeSnapshot } from './append_only_tree_snapshot.js';

describe('AppendOnlyTreeSnapshot', () => {
  const root = Fr.fromString('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

  // The tallest configured trees are 42 levels deep, so a full-tree next-available position needs 43 bits.
  const indices = [0, 1, 2 ** 32 - 1, 2 ** 32, 2 ** 42, Number.MAX_SAFE_INTEGER];

  it.each(indices)('round trips index %p through a buffer', index => {
    const snapshot = new AppendOnlyTreeSnapshot(root, index);
    expect(AppendOnlyTreeSnapshot.fromBuffer(snapshot.toBuffer())).toEqual(snapshot);
  });

  it.each(indices)('round trips index %p through a string', index => {
    const snapshot = new AppendOnlyTreeSnapshot(root, index);
    expect(AppendOnlyTreeSnapshot.fromString(snapshot.toString())).toEqual(snapshot);
  });

  it.each(indices)('round trips index %p through fields', index => {
    const snapshot = new AppendOnlyTreeSnapshot(root, index);
    expect(AppendOnlyTreeSnapshot.fromFields(snapshot.toFields())).toEqual(snapshot);
  });

  it.each(indices)('round trips index %p through the schema', index => {
    const snapshot = new AppendOnlyTreeSnapshot(root, index);
    expect(AppendOnlyTreeSnapshot.schema.parse(JSON.parse(jsonStringify(snapshot)))).toEqual(snapshot);
  });

  it.each(indices)('round trips index %p through a plain object', index => {
    const snapshot = new AppendOnlyTreeSnapshot(root, index);
    expect(AppendOnlyTreeSnapshot.fromPlainObject({ root, nextAvailableLeafIndex: index })).toEqual(snapshot);
  });

  it('parses an index supplied as a decimal string beyond the 32-bit range', () => {
    const index = 2 ** 42;
    const parsed = AppendOnlyTreeSnapshot.schema.parse({
      root: root.toString(),
      nextAvailableLeafIndex: index.toString(),
    });
    expect(parsed.nextAvailableLeafIndex).toBe(index);
  });

  it('serializes to the size it reports', () => {
    const snapshot = new AppendOnlyTreeSnapshot(root, 2 ** 42);
    expect(snapshot.getSize()).toBe(40);
    expect(snapshot.toBuffer().length).toBe(snapshot.getSize());
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 2, NaN, Infinity])('rejects invalid index %p', index => {
    expect(() => new AppendOnlyTreeSnapshot(root, index)).toThrow();
  });

  it('rejects a buffer holding an index above the safe integer range', () => {
    const buffer = Buffer.concat([root.toBuffer(), Buffer.alloc(8, 0xff)]);
    expect(() => AppendOnlyTreeSnapshot.fromBuffer(buffer)).toThrow();
  });

  it('rejects a field holding an index above the safe integer range', () => {
    expect(() => AppendOnlyTreeSnapshot.fromFields([root, new Fr(2n ** 64n)])).toThrow();
  });
});
