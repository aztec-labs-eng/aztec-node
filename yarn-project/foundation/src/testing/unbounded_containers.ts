import { z } from 'zod';

import type { ApiSchema } from '../schemas/api.js';
import { sizeCheckedBeforeParse } from '../schemas/utils.js';

/**
 * Depth past which the walk stops expanding lazy schemas, whose getter may build a new schema on every call. Only lazy
 * schemas can make a walk unbounded, so other schemas past it are still walked. A lazy schema left unexpanded is
 * reported rather than passed, since its unvisited part may hold unbounded containers.
 */
const MAX_WALK_DEPTH = 64;

/**
 * Lists the paths in a schema to arrays, sets, maps and records whose size is not checked before their entries are
 * parsed. zod records one issue per invalid entry, so an oversized container of junk at any of these paths makes a
 * parse allocate memory proportional to the input. zod only checks the leading size checks of an array, set or map
 * before parsing it, so a bound added after a refinement does not count; records need a guard such as `boundedRecord`.
 * Objects with a catchall (including passthrough and loose objects) run it over every undeclared key, and tuples with a
 * rest element run it over every extra element, with no size check zod can apply first, so both are reported. Paths
 * the walk gives up on past its depth limit are reported as too deep to inspect. Custom schemas are opaque and treated
 * as bounded.
 */
export function findUnboundedContainers(schema: z.core.$ZodType, path = ''): string[] {
  const found: string[] = [];
  walk(schema, path, found, new WeakSet(), 0);
  return found;
}

/**
 * Runs {@link findUnboundedContainers} on the parameters of every method in an API schema, which a server parses from
 * untrusted callers. Return values are deliberately left out: a client trusts the node or wallet it talks to, so what
 * the server sends back needs no size bound. Paths start with the method name, followed by `(n)` for the n-th
 * parameter or `(...)` for a rest parameter.
 */
export function findUnboundedContainersInApi(api: ApiSchema): string[] {
  return Object.entries(api).flatMap(([method, fn]) => {
    const found: string[] = [];
    walkParameters(fn.def.input, method, found, new WeakSet(), 0);
    return found;
  });
}

/** Walks a function's parameter tuple, labelling each parameter `(n)` and a rest parameter `(...)`. */
function walkParameters(
  input: z.core.$ZodType | undefined,
  path: string,
  found: string[],
  visited: WeakSet<z.core.$ZodType>,
  depth: number,
): void {
  if (input) {
    walk(input, path, found, visited, depth, (index: number | '...') => `${path}(${index})`);
  }
}

function walk(
  schema: z.core.$ZodType,
  path: string,
  found: string[],
  visited: WeakSet<z.core.$ZodType>,
  depth: number,
  tupleElementPath = (index: number | '...') => `${path}[${index}]`,
): void {
  if (visited.has(schema)) {
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
      if (def.catchall && def.catchall._zod.def.type !== 'never' && !sizeCheckedBeforeParse.has(schema)) {
        found.push(`${path}.*`);
      }
      return next(def.catchall, `${path}.*`);
    case 'tuple':
      (def.items as z.core.$ZodType[]).forEach((item, i) => next(item, tupleElementPath(i)));
      if (def.rest) {
        found.push(tupleElementPath('...'));
      }
      return next(def.rest, tupleElementPath('...'));
    case 'union':
      return (def.options as z.core.$ZodType[]).forEach(option => next(option, path));
    case 'intersection':
      next(def.left, path);
      return next(def.right, path);
    case 'pipe':
      next(def.in, path);
      return next(def.out, path);
    case 'lazy': {
      const inner: z.core.$ZodType = def.getter();
      if (!visited.has(inner) && depth >= MAX_WALK_DEPTH) {
        found.push(`${path} (too deep to inspect)`);
        return;
      }
      return next(inner, path);
    }
    case 'function':
      walkParameters(def.input, path, found, visited, depth + 1);
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
