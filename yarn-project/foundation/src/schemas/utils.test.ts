import { z } from 'zod';

import { selectorSchema } from './utils.js';

describe('selectorSchema', () => {
  const byNumber = z.object({ number: z.number() });
  const byName = z.object({ name: z.string() });
  const byNumberAndName = z.object({ number: z.number(), name: z.string() });

  const schema = selectorSchema<{ number: number } | { name: string }>([byNumber, byName]);

  it('accepts each alternative', () => {
    expect(schema.parse({ number: 1 })).toEqual({ number: 1 });
    expect(schema.parse({ name: 'a' })).toEqual({ name: 'a' });
  });

  it('drops a key the family does not know and hands the handler the rest', () => {
    expect(schema.parse({ number: 1, futureOption: true })).toEqual({ number: 1 });
  });

  it('still rejects a combination of keys it does know', () => {
    expect(schema.safeParse({ number: 1, name: 'a' }).success).toBe(false);
  });

  it('still rejects an invalid value for a key it knows', () => {
    expect(schema.safeParse({ number: 'one' }).success).toBe(false);
    expect(schema.safeParse({ number: 'one', futureOption: true }).success).toBe(false);
  });

  it('rejects an object left with nothing it knows', () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ futureOption: true }).success).toBe(false);
  });

  it('passes anything that is not a plain object through to the alternatives', () => {
    expect(schema.safeParse('number').success).toBe(false);
    expect(schema.safeParse([{ number: 1 }]).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it('accepts a single alternative without a union', () => {
    const only = selectorSchema<{ number: number; name: string }>([byNumberAndName]);

    expect(only.parse({ number: 1, name: 'a', futureOption: true })).toEqual({ number: 1, name: 'a' });
    expect(only.safeParse({ number: 1 }).success).toBe(false);
  });

  it('keeps a key the family knows but this endpoint does not accept, so the combination is refused', () => {
    // `name` means something elsewhere in the family, so an object carrying it is a contradiction rather than a
    // stray field, even here where only `{ number }` is served.
    const numbersOnly = selectorSchema<{ number: number }>([byNumber], ['number', 'name']);

    expect(numbersOnly.safeParse({ number: 1, name: 'a' }).success).toBe(false);
    expect(numbersOnly.parse({ number: 1, futureOption: true })).toEqual({ number: 1 });
  });

  it('leaves optional keys of an accepted shape optional', () => {
    const withFlag = selectorSchema<{ number: number; reverse?: boolean }>([
      z.object({ number: z.number(), reverse: z.boolean().optional() }),
    ]);

    expect(withFlag.parse({ number: 1 })).toEqual({ number: 1 });
    expect(withFlag.parse({ number: 1, reverse: true, futureOption: 'x' })).toEqual({ number: 1, reverse: true });
    expect(withFlag.safeParse({ number: 1, reverse: 'yes' }).success).toBe(false);
  });
});
