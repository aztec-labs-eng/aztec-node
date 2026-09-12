import { describe, expect, it } from 'vitest';

import { mapRange } from './common.js';

describe('mapRange', () => {
  const toKey = (index: bigint) => Number(index);

  it('keeps zero bounds instead of dropping them', () => {
    // Zero is a valid key, so an exclusive end of zero must select nothing rather than leaving the range unbounded.
    expect(mapRange({ start: 0n, end: 0n }, toKey)).toEqual({ start: 0, end: 0, reverse: undefined, limit: undefined });
    expect(mapRange({ end: 0n }, toKey)).toEqual({ start: undefined, end: 0, reverse: undefined, limit: undefined });
    expect(mapRange({ start: 0n, end: 2n }, toKey)).toEqual({
      start: 0,
      end: 2,
      reverse: undefined,
      limit: undefined,
    });
  });

  it('leaves absent bounds undefined and carries the rest of the range through', () => {
    expect(mapRange({ start: 3n, reverse: true, limit: 5 }, toKey)).toEqual({
      start: 3,
      end: undefined,
      reverse: true,
      limit: 5,
    });
    expect(mapRange({}, toKey)).toEqual({ start: undefined, end: undefined, reverse: undefined, limit: undefined });
  });
});
