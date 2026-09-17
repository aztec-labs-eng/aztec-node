import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { BlockHash } from './block_hash.js';
import {
  type BlockParameter,
  BlockParameterSchema,
  blockParameterHash,
  inspectBlockParameter,
  isAnchoredBlockParameter,
} from './block_parameter.js';

describe('BlockParameterSchema', () => {
  it.each<[string, BlockParameter]>([
    ['number', BlockNumber(7)],
    ['BlockHash', BlockHash.fromBuffer(Buffer.alloc(32, 1))],
    ['tag latest', 'latest'],
    ['tag proposed', 'proposed'],
    ['tag checkpointed', 'checkpointed'],
    ['tag proven', 'proven'],
    ['tag finalized', 'finalized'],
    ['{ number }', { number: BlockNumber(7) }],
    ['{ hash }', { hash: BlockHash.fromBuffer(Buffer.alloc(32, 1)) }],
    ['{ archive }', { archive: new Fr(123) }],
    ['{ tag }', { tag: 'proven' }],
    ['{ number, hash }', { number: BlockNumber(7), hash: BlockHash.fromBuffer(Buffer.alloc(32, 1)) }],
  ])('roundtrips %s', (_, param) => {
    const json = JSON.parse(JSON.stringify(param));
    const parsed = BlockParameterSchema.parse(json);
    expect(parsed).toEqual(param);
  });

  it('parses a 32-byte hex string as a BlockHash, never coercing it to a JS number', () => {
    const blockHash = BlockHash.fromBuffer(Buffer.alloc(32, 0x07));
    const wire = blockHash.toString();
    const parsed = BlockParameterSchema.parse(wire);
    expect(BlockHash.isBlockHash(parsed)).toBe(true);
    expect((parsed as BlockHash).toString()).toEqual(wire);
  });

  it('rejects huge JS numbers (above MAX_SAFE_INTEGER) for block-number parsing', () => {
    expect(BlockParameterSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(BlockParameterSchema.safeParse(-1).success).toBe(false);
  });

  it('rejects non-integer numbers', () => {
    expect(BlockParameterSchema.safeParse(1.5).success).toBe(false);
  });

  it('rejects unknown tags', () => {
    expect(BlockParameterSchema.safeParse('not-a-tag').success).toBe(false);
  });

  it.each([
    ['number and archive', { number: 7, archive: new Fr(123).toString() }],
    ['hash and tag', { hash: BlockHash.fromBuffer(Buffer.alloc(32, 1)).toString(), tag: 'proven' }],
    ['number, hash and tag', { number: 7, hash: BlockHash.fromBuffer(Buffer.alloc(32, 1)).toString(), tag: 'proven' }],
  ])('rejects an object combining selectors that do not name one block: %s', (_, wire) => {
    expect(BlockParameterSchema.safeParse(wire).success).toBe(false);
  });

  it.each([
    ['a bare number', { number: 7, futureOption: true }, { number: BlockNumber(7) }],
    [
      'an anchor',
      { number: 7, hash: BlockHash.fromBuffer(Buffer.alloc(32, 1)).toString(), futureOption: true },
      { number: BlockNumber(7), hash: BlockHash.fromBuffer(Buffer.alloc(32, 1)) },
    ],
    ['a tag', { tag: 'proven', futureOption: { nested: true } }, { tag: 'proven' }],
  ])('drops a key it does not know from %s', (_, wire, expected) => {
    expect(BlockParameterSchema.parse(wire)).toEqual(expected);
  });

  it('rejects an object left naming no block', () => {
    expect(BlockParameterSchema.safeParse({}).success).toBe(false);
    expect(BlockParameterSchema.safeParse({ futureOption: true }).success).toBe(false);
  });

  it('rejects an invalid value for a key it knows even alongside one it does not', () => {
    expect(BlockParameterSchema.safeParse({ tag: 'not-a-tag', futureOption: true }).success).toBe(false);
    expect(BlockParameterSchema.safeParse({ number: -1, futureOption: true }).success).toBe(false);
    expect(BlockParameterSchema.safeParse({ number: 7, hash: 'invalid', futureOption: true }).success).toBe(false);
  });

  it('drops fields used by other methods', () => {
    expect(BlockParameterSchema.parse({ number: 7, limit: 5, onlyCheckpointed: true })).toEqual({
      number: BlockNumber(7),
    });
  });

  it('rejects an anchor missing either half', () => {
    expect(BlockParameterSchema.safeParse({ number: 7, hash: undefined }).success).toBe(false);
    expect(BlockParameterSchema.safeParse({ number: undefined, hash: BlockHash.random().toString() }).success).toBe(
      false,
    );
  });
});

describe('isAnchoredBlockParameter', () => {
  const hash = BlockHash.fromBuffer(Buffer.alloc(32, 1));

  it('recognizes only the form naming a block by both number and hash', () => {
    expect(isAnchoredBlockParameter({ number: BlockNumber(7), hash })).toBe(true);
    expect(isAnchoredBlockParameter({ number: BlockNumber(7) })).toBe(false);
    expect(isAnchoredBlockParameter({ hash })).toBe(false);
    expect(isAnchoredBlockParameter(BlockNumber(7))).toBe(false);
    expect(isAnchoredBlockParameter(hash)).toBe(false);
    expect(isAnchoredBlockParameter('proven')).toBe(false);
  });
});

describe('blockParameterHash', () => {
  const hash = BlockHash.fromBuffer(Buffer.alloc(32, 1));

  it('reads the hash out of every form that pins one', () => {
    expect(blockParameterHash(hash)).toEqual(hash);
    expect(blockParameterHash({ hash })).toEqual(hash);
    expect(blockParameterHash({ number: BlockNumber(7), hash })).toEqual(hash);
  });

  it('answers undefined for forms that name a moving position', () => {
    expect(blockParameterHash(BlockNumber(7))).toBeUndefined();
    expect(blockParameterHash({ number: BlockNumber(7) })).toBeUndefined();
    expect(blockParameterHash({ archive: new Fr(123) })).toBeUndefined();
    expect(blockParameterHash('proven')).toBeUndefined();
  });
});

describe('inspectBlockParameter', () => {
  const hash = BlockHash.fromBuffer(Buffer.alloc(32, 1));

  it('shows both halves of an anchor', () => {
    expect(inspectBlockParameter({ number: BlockNumber(7), hash })).toEqual(`number=7,hash=${hash.toString()}`);
  });

  it('shows the single selector of every other object form', () => {
    expect(inspectBlockParameter({ number: BlockNumber(7) })).toEqual('number=7');
    expect(inspectBlockParameter({ hash })).toEqual(`hash=${hash.toString()}`);
  });
});
