import { z } from 'zod';

import type { ApiSchema } from '../schemas/api.js';
import { sizeCheckedBeforeParse } from '../schemas/utils.js';

/** Recursion limit for walking lazy schemas whose getter builds a new schema on every call. */
const MAX_WALK_DEPTH = 64;

/**
 * Lists the paths in a schema to arrays, sets, maps and records whose size is not checked before their entries are
 * parsed. zod records one issue per invalid entry, so an oversized container of junk at any of these paths makes a
 * parse allocate memory proportional to the input. zod only checks the leading size checks of an array, set or map
 * before parsing it, so a bound added after a refinement does not count; records need a guard such as `boundedRecord`.
 * Custom schemas are opaque and treated as bounded.
 */
export function findUnboundedContainers(schema: z.core.$ZodType, path = ''): string[] {
  const found: string[] = [];
  walk(schema, path, found, new Set(), 0);
  return found;
}

/**
 * Runs {@link findUnboundedContainers} on the parameters of every method in an API schema, which a server parses from
 * untrusted callers. Pass `returnValues` to also check what a client parses from the server. Paths start with the
 * method name, followed by `(n)` for the n-th parameter or `=>` for the return value.
 */
export function findUnboundedContainersInApi(api: ApiSchema, opts: { returnValues?: boolean } = {}): string[] {
  return Object.entries(api).flatMap(([method, fn]) => [
    ...(fn.def.input?._zod.def.items ?? []).flatMap((param: z.core.$ZodType, i: number) =>
      findUnboundedContainers(param, `${method}(${i})`),
    ),
    ...(opts.returnValues ? findUnboundedContainers(fn.def.output, `${method} =>`) : []),
  ]);
}

function walk(
  schema: z.core.$ZodType,
  path: string,
  found: string[],
  visited: Set<z.core.$ZodType>,
  depth: number,
): void {
  if (visited.has(schema) || depth > MAX_WALK_DEPTH) {
    return;
  }
  visited.add(schema);
  const next = (child: z.core.$ZodType | undefined, childPath: string) =>
    child && walk(child, childPath, found, visited, depth + 1);
  const def = schema._zod.def as z.core.$ZodTypeDef & Record<string, any>;

  switch (def.type) {
    case 'array':
      checkSize(schema, `${path}[]`, found);
      return next(def.element, `${path}[]`);
    case 'set':
      checkSize(schema, `${path}{}`, found);
      return next(def.valueType, `${path}{}`);
    case 'map':
      checkSize(schema, `${path}{}`, found);
      next(def.keyType, `${path}{key}`);
      return next(def.valueType, `${path}{}`);
    case 'record':
      if (!sizeCheckedBeforeParse.has(schema) && !hasFiniteKeys(def.keyType)) {
        found.push(`${path}{}`);
      }
      return next(def.valueType, `${path}{}`);
    case 'object':
      for (const [key, value] of Object.entries(def.shape as Record<string, z.core.$ZodType>)) {
        next(value, `${path}.${key}`);
      }
      return next(def.catchall, `${path}.*`);
    case 'tuple':
      (def.items as z.core.$ZodType[]).forEach((item, i) => next(item, `${path}[${i}]`));
      return next(def.rest, `${path}[...]`);
    case 'union':
      return (def.options as z.core.$ZodType[]).forEach(option => next(option, path));
    case 'intersection':
      next(def.left, path);
      return next(def.right, path);
    case 'pipe':
      next(def.in, path);
      return next(def.out, path);
    case 'lazy':
      return next(def.getter(), path);
    case 'function':
      (def.input?._zod.def.items ?? []).forEach((param: z.core.$ZodType, i: number) => next(param, `${path}(${i})`));
      return next(def.output, `${path} =>`);
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
    case 'promise':
      return next(def.innerType, path);
    default:
      return;
  }
}

function checkSize(schema: z.core.$ZodType, path: string, found: string[]) {
  if (z.core.util.sizeCaps(schema._zod.def.checks).length === 0) {
    found.push(path);
  }
}

function hasFiniteKeys(keyType: z.core.$ZodType): boolean {
  return keyType._zod.values !== undefined;
}
