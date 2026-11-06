import { z } from 'zod';

import { Buffer32 } from '../buffer/buffer32.js';
import { schemas } from './schemas.js';
import { boundedRecord, optional } from './utils.js';

describe('schemas', () => {
  describe('optional', () => {
    it('applies a wrapped default for both undefined and null', () => {
      const schema = optional(z.number().gte(1).lte(50).default(50));
      expect(schema.parse(undefined)).toEqual(50);
      // JSON encodes a skipped leading argument as null; it must still reach the default.
      expect(schema.parse(null)).toEqual(50);
      expect(schema.parse(10)).toEqual(10);
    });

    it('maps null and undefined to undefined when the wrapped schema has no default', () => {
      const schema = optional(z.string());
      expect(schema.parse(undefined)).toBeUndefined();
      expect(schema.parse(null)).toBeUndefined();
      expect(schema.parse('x')).toEqual('x');
    });
  });

  describe('boundedRecord', () => {
    const schema = boundedRecord(z.string(), z.number(), 2);

    it('parses a record within the bound', () => {
      expect(schema.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    });

    it('rejects an oversized record of invalid entries with a single issue', () => {
      const input = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, 'not a number']));
      expect(schema.safeParse(input).error?.issues).toHaveLength(1);
    });

    it('rejects an array as a type mismatch without enumerating its elements', () => {
      const array = new Proxy(new Array(1_000_000).fill(0), {
        ownKeys: () => {
          throw new Error('enumerated the array');
        },
      });
      expect(schema.safeParse(array).error?.issues).toEqual([
        expect.objectContaining({ code: 'invalid_type', expected: 'record' }),
      ]);
    });
  });

  describe('Buffer32', () => {
    it('parses a valid hex string into a Buffer32', () => {
      const buffer32 = Buffer32.random();
      const parsed = schemas.Buffer32.parse(buffer32.toString());
      expect(parsed).toBeInstanceOf(Buffer32);
      expect(parsed.equals(buffer32)).toBe(true);
    });
  });

  describe('Boolean', () => {
    it('accepts a boolean value', () => {
      expect(schemas.Boolean.parse(true)).toEqual(true);
      expect(schemas.Boolean.parse(false)).toEqual(false);
    });

    it('accepts a numeric value', () => {
      expect(schemas.Boolean.parse(1)).toEqual(true);
      expect(schemas.Boolean.parse(0)).toEqual(false);
    });

    it('rejects a non binary numeric value', () => {
      expect(schemas.Boolean.safeParse(2).success).toEqual(false);
    });

    it('accepts string values', () => {
      expect(schemas.Boolean.parse('true')).toEqual(true);
      expect(schemas.Boolean.parse('false')).toEqual(false);
      expect(schemas.Boolean.parse('TRUE')).toEqual(true);
      expect(schemas.Boolean.parse('FALSE')).toEqual(false);
      expect(schemas.Boolean.parse('True')).toEqual(true);
      expect(schemas.Boolean.parse('False')).toEqual(false);
      expect(schemas.Boolean.parse(' true ')).toEqual(true);
      expect(schemas.Boolean.parse(' false ')).toEqual(false);
    });

    it('accepts numeric values as string', () => {
      expect(schemas.Boolean.parse('1')).toEqual(true);
      expect(schemas.Boolean.parse('0')).toEqual(false);
    });

    it('rejects other string values', () => {
      expect(schemas.Boolean.safeParse('falso').success).toEqual(false);
    });

    it('rejects empty strings', () => {
      expect(schemas.Boolean.safeParse('').success).toEqual(false);
    });

    it('handles defaults', () => {
      expect(schemas.Boolean.optional().default(true).parse(undefined)).toEqual(true);
      expect(schemas.Boolean.optional().default(false).parse(undefined)).toEqual(false);
    });
  });
});
