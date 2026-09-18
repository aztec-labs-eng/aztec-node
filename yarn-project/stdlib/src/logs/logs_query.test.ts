import { jsonStringify } from '@aztec-labs/foundation/json-rpc';

import { AztecAddress } from '../aztec-address/index.js';
import { BlockHash } from '../block/block_hash.js';
import { MAX_RPC_LEN } from '../interfaces/api_limit.js';
import { PrivateLogsQuerySchema, PublicLogsQuerySchema, ResolvedPrivateLogsQuerySchema } from './logs_query.js';
import { SiloedTag } from './siloed_tag.js';
import { Tag } from './tag.js';

/** Serialize a query through the JSON wire format the schemas are designed to parse. */
function wire<T>(value: T): unknown {
  return JSON.parse(jsonStringify(value));
}

describe('PrivateLogsQuerySchema', () => {
  it('accepts a tags array of exactly MAX_RPC_LEN entries', () => {
    const tags = Array.from({ length: MAX_RPC_LEN }, () => SiloedTag.random());
    expect(() => PrivateLogsQuerySchema.parse(wire({ tags }))).not.toThrow();
  });

  it('rejects a tags array longer than MAX_RPC_LEN', () => {
    const tags = Array.from({ length: MAX_RPC_LEN + 1 }, () => SiloedTag.random());
    expect(() => PrivateLogsQuerySchema.parse(wire({ tags }))).toThrow(/at most/);
  });

  it('rejects an empty tags array', () => {
    expect(() => PrivateLogsQuerySchema.parse(wire({ tags: [] }))).toThrow();
  });
});

describe('PublicLogsQuerySchema', () => {
  it('accepts a tags array of exactly MAX_RPC_LEN entries', async () => {
    const contractAddress = await AztecAddress.random();
    const tags = Array.from({ length: MAX_RPC_LEN }, () => Tag.random());
    expect(() => PublicLogsQuerySchema.parse(wire({ contractAddress, tags }))).not.toThrow();
  });

  it('rejects a tags array longer than MAX_RPC_LEN', async () => {
    const contractAddress = await AztecAddress.random();
    const tags = Array.from({ length: MAX_RPC_LEN + 1 }, () => Tag.random());
    expect(() => PublicLogsQuerySchema.parse(wire({ contractAddress, tags }))).toThrow(/at most/);
  });

  it('rejects an empty tags array', async () => {
    const contractAddress = await AztecAddress.random();
    expect(() => PublicLogsQuerySchema.parse(wire({ contractAddress, tags: [] }))).toThrow();
  });
});

describe('logs query reference blocks', () => {
  const tags = [SiloedTag.random()];
  const hash = BlockHash.random();

  it('accepts a bare block hash', () => {
    const parsed = PrivateLogsQuerySchema.parse(wire({ tags, referenceBlock: hash }));
    expect(parsed.referenceBlock).toEqual(hash);
  });

  it('accepts an anchor naming the block by number and hash', () => {
    const parsed = PrivateLogsQuerySchema.parse(wire({ tags, referenceBlock: { number: 7, hash } }));
    expect(parsed.referenceBlock).toEqual({ number: 7, hash });
  });

  it.each([
    ['a bare number', 7],
    ['{ number }', { number: 7 }],
    ['{ hash }', { hash: BlockHash.random() }],
    ['a tag', 'proven'],
    ['{ tag }', { tag: 'proven' }],
    ['{ archive }', { archive: BlockHash.random() }],
  ])('rejects %s, which does not pin a fork', (_, referenceBlock) => {
    expect(PrivateLogsQuerySchema.safeParse(wire({ tags, referenceBlock })).success).toBe(false);
  });

  it('only lets a bare hash past the resolved schema the logs source is read with', () => {
    expect(ResolvedPrivateLogsQuerySchema.parse(wire({ tags, referenceBlock: hash })).referenceBlock).toEqual(hash);
    expect(ResolvedPrivateLogsQuerySchema.safeParse(wire({ tags, referenceBlock: { number: 7, hash } })).success).toBe(
      false,
    );
  });
});
