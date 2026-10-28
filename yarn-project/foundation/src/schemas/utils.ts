import { Buffer } from 'buffer';
import { type ZodObject, type ZodRawShape, type ZodType, type ZodTypeAny, z } from 'zod';

import { pick } from '../collection/object.js';
import { isHex, withoutHexPrefix } from '../string/index.js';
import type { ZodFor } from './types.js';

export const hexSchema = z.string().refine(isHex, 'Not a valid hex string').transform(withoutHexPrefix);

// Copied from zod internals, which was copied from https://stackoverflow.com/questions/7860392/determine-if-string-is-in-base64-using-javascript
const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;

const isByte = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;

/**
 * Byte array checked as a whole, so a malformed array yields a single issue rather than one per element. A buffer has
 * no natural size bound to declare with `.max()`, so this is what keeps an oversized array of junk from allocating
 * memory proportional to its length.
 */
const byteArraySchema = z.custom<number[]>(
  value => Array.isArray(value) && value.every(isByte),
  'Not a valid byte array',
);

/** Schema for a buffer represented as a base64 string or a Buffer object. */
export const bufferSchema: ZodFor<Buffer> = z.union([
  // Serialization from base64 string.
  z
    .string()
    // We only test the str for base64 if it's shorter than 1024 bytes, otherwise we've run into maximum
    // stack size exceeded errors when trying to validate excessively long strings (such as contract bytecode).
    .refine(str => str.length > 1024 || base64Regex.test(str), 'Not a valid base64 string')
    .transform(data => Buffer.from(data, 'base64')),
  // Serialization from Buffer-annotated object.
  z
    .object({
      type: z.literal('Buffer'),
      data: byteArraySchema,
    })
    .transform(({ data }) => Buffer.from(data)),
  // Serialization from Buffer
  z.instanceof(Buffer),
]);

export type ZodNullableOptional<T extends ZodTypeAny> = ZodType<z.output<T> | undefined, z.input<T> | null | undefined>;

/**
 * Declares a parameter as optional. Use this over z.optional in order to accept nulls as undefineds.
 * This is required as JSON does not have an undefined type, and null is used to represent it, so we
 * need to convert nulls to undefineds as we parse.
 *
 * A wrapped `.default(...)` must fire when the field arrives as null, so normalize null and undefined
 * to undefined before the schema runs. A default schema is fed the value directly; wrapping it in
 * `.optional()` would short-circuit undefined past the default. A schema without a default is made
 * optional so a missing value is accepted.
 */
export function optional<T extends ZodTypeAny>(schema: T) {
  // Both null and undefined mean "absent" and normalize to undefined. JSON has no undefined, so a
  // skipped argument arrives as null, and a wrapped `.default(...)` must still fire on it. `.nullish()`
  // short-circuits null before a wrapped default, so a default schema is fed the normalized value
  // directly; the cast keeps the same caller-facing type as the plain optional case.
  const asOptional = schema.nullish().transform(value => value ?? undefined);
  if (schema instanceof z.ZodDefault) {
    return z.preprocess(value => value ?? undefined, schema) as unknown as typeof asOptional;
  }
  return asOptional;
}

type ToJsonIs<T, TRet> = T extends { toJSON(): TRet } ? T : never;

/**
 * Creates a schema that accepts a hex string and uses it to hydrate an instance.
 * @param klazz - Class that implements either fromString or fromBuffer.
 * @returns A schema for the class.
 */
export function hexSchemaFor<TClass extends { fromString(str: string): any } | { fromBuffer(buf: Buffer): any }>(
  klazz: TClass,
  refinement?: (input: string) => boolean,
): ZodType<
  TClass extends { fromString(str: string): infer TInstance } | { fromBuffer(buf: Buffer): infer TInstance }
    ? ToJsonIs<TInstance, string>
    : never,
  string
> {
  const stringSchema = refinement ? z.string().refine(refinement, `Not a valid instance`) : z.string();
  const hexSchema = stringSchema.refine(isHex, 'Not a valid hex string');
  return 'fromString' in klazz
    ? hexSchema.transform(klazz.fromString.bind(klazz))
    : hexSchema.transform(str => Buffer.from(withoutHexPrefix(str), 'hex')).transform(klazz.fromBuffer.bind(klazz));
}

/**
 * Creates a schema that accepts a base64 string and uses it to hydrate an instance.
 * @param klazz - Class that implements fromBuffer.
 * @returns A schema for the class.
 */
export function bufferSchemaFor<TClass extends { fromBuffer(buf: Buffer): any }>(
  klazz: TClass,
  refinement?: (buf: Buffer) => boolean,
): ZodType<TClass extends { fromBuffer(buf: Buffer): infer TInstance } ? ToJsonIs<TInstance, Buffer> : never, string> {
  return bufferSchema.refine(refinement ?? (() => true), 'Not a valid buffer').transform(klazz.fromBuffer.bind(klazz));
}

/**
 * Creates a schema for a js Map type that matches the serialization used in jsonStringify.
 * @param maxSize - Maximum number of entries. Required when parsing untrusted input; omit only for trusted local data.
 */
export function mapSchema<TKey, TValue>(
  key: ZodFor<TKey>,
  value: ZodFor<TValue>,
  maxSize?: number,
): ZodFor<Map<TKey, TValue>> {
  // eslint-disable-next-line aztec-custom/no-unbounded-zod-array -- bounded below when maxSize is given; omitted only for trusted data
  const entries = z.array(z.tuple([key, value]));
  return (maxSize === undefined ? entries : entries.max(maxSize)).transform(parsed => new Map(parsed));
}

/**
 * Creates a schema for a js Set type that matches the serialization used in jsonStringify.
 * @param maxSize - Maximum number of entries. Required when parsing untrusted input; omit only for trusted local data.
 */
export function setSchema<T>(value: ZodFor<T>, maxSize?: number): ZodFor<Set<T>> {
  // eslint-disable-next-line aztec-custom/no-unbounded-zod-array -- bounded below when maxSize is given; omitted only for trusted data
  const entries = z.array(value);
  return (maxSize === undefined ? entries : entries.max(maxSize)).transform(parsed => new Set(parsed));
}

/**
 * Creates a record schema that rejects objects with more than `maxKeys` keys before parsing any entry. A record has no
 * size bound zod checks up front, and a `.refine` on the record would only run after every entry was parsed.
 */
export function boundedRecord<TKey extends z.core.$ZodRecordKey, TValue extends ZodTypeAny>(
  key: TKey,
  value: TValue,
  maxKeys: number,
) {
  return z
    .custom<object>(input => typeof input === 'object' && input !== null && Object.keys(input).length <= maxKeys, {
      message: `Must have at most ${maxKeys} entries`,
    })
    .pipe(z.record(key, value));
}

/**
 * Wraps a recursive schema so that input nested more than `maxDepth` arrays or objects deep fails before zod recurses
 * into it. Parsing deeply nested input through `z.lazy` otherwise overflows the stack.
 */
export function withMaxDepth<T extends ZodTypeAny>(schema: T, maxDepth: number) {
  return z
    .custom<unknown>(input => !isNestedDeeperThan(input, maxDepth), {
      message: `Must not be nested more than ${maxDepth} levels deep`,
    })
    .pipe(schema);
}

function isNestedDeeperThan(input: unknown, maxDepth: number): boolean {
  const pending: [unknown, number][] = [[input, 0]];
  while (pending.length > 0) {
    const [value, depth] = pending.pop()!;
    if (value === null || typeof value !== 'object') {
      continue;
    }
    if (depth >= maxDepth) {
      return true;
    }
    for (const child of Object.values(value)) {
      pending.push([child, depth + 1]);
    }
  }
  return false;
}

/** Given an already parsed and validated object, extracts the keys defined in the given schema. Does not validate again. */
export function pickFromSchema<T extends object, S extends ZodObject<ZodRawShape>>(obj: T, schema: S) {
  return pick(obj, ...Object.keys(schema.shape));
}
