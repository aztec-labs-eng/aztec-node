import { z } from 'zod';

import { boundedRecord, mapSchema, setSchema } from '../schemas/utils.js';
import { findUnboundedContainers, findUnboundedContainersInApi } from './unbounded_containers.js';

describe('findUnboundedContainers', () => {
  it('flags arrays without a size bound', () => {
    expect(findUnboundedContainers(z.object({ a: z.array(z.number()), b: z.number().array().max(2) }))).toEqual([
      '.a[]',
    ]);
  });

  it('accepts arrays bounded by max or length', () => {
    expect(findUnboundedContainers(z.tuple([z.array(z.string()).max(3), z.array(z.string()).length(3)]))).toEqual([]);
  });

  it('flags a bound that zod only checks after a refinement', () => {
    const schema = z
      .array(z.number())
      .refine(arr => arr.length > 0)
      .max(3);
    expect(findUnboundedContainers(schema)).toEqual(['[]']);
  });

  it('flags nested arrays bounded only on the outside', () => {
    expect(findUnboundedContainers(z.array(z.array(z.number())).max(2))).toEqual(['[][]']);
  });

  it('flags sets and maps without a size bound', () => {
    expect(findUnboundedContainers(z.object({ s: z.set(z.number()), m: z.map(z.string(), z.number()) }))).toEqual([
      '.s{}',
      '.m{}',
    ]);
    expect(findUnboundedContainers(z.set(z.number()).max(2))).toEqual([]);
  });

  it('flags mapSchema and setSchema only when called without a size', () => {
    expect(findUnboundedContainers(setSchema(z.number()))).toEqual(['[]']);
    expect(findUnboundedContainers(mapSchema(z.string(), z.number(), 10))).toEqual([]);
  });

  it('flags records unless their size is checked before parsing or their keys are finite', () => {
    expect(findUnboundedContainers(z.record(z.string(), z.number()))).toEqual(['{}']);
    expect(
      findUnboundedContainers(
        z.record(
          z.number().refine(() => true),
          z.number(),
        ),
      ),
    ).toEqual(['{}']);
    expect(findUnboundedContainers(boundedRecord(z.string(), z.number(), 10))).toEqual([]);
    expect(findUnboundedContainers(z.record(z.enum(['a', 'b']), z.number()))).toEqual([]);
  });

  it('walks through wrappers, unions and transforms', () => {
    const schema = z.union([
      z.object({ x: z.array(z.number()).optional() }),
      z
        .object({ y: z.array(z.number()).nullable().default([]) })
        .transform(({ y }) => y)
        .pipe(z.array(z.number()).max(2)),
    ]);
    expect(findUnboundedContainers(schema)).toEqual(['.x[]', '.y[]']);
  });

  it('terminates on recursive schemas', () => {
    type Tree = { children: Tree[] };
    const tree: z.ZodType<Tree> = z.object({ children: z.array(z.lazy(() => tree)) });
    expect(findUnboundedContainers(tree)).toEqual(['.children[]']);
  });

  it('reports lazy schemas that build a new schema on every call as too deep to inspect', () => {
    const build = (): z.ZodType => z.object({ next: z.lazy(build), items: z.array(z.number()).max(1) });
    expect(findUnboundedContainers(build())).toEqual([expect.stringMatching(/^(\.next)+ \(too deep to inspect\)$/)]);
  });

  it('flags objects that parse undeclared keys through a catchall', () => {
    expect(findUnboundedContainers(z.object({ a: z.number() }).catchall(z.number()))).toEqual(['.*']);
    expect(findUnboundedContainers(z.looseObject({ a: z.number() }))).toEqual(['.*']);
    expect(findUnboundedContainers(z.object({ a: z.number() }).passthrough())).toEqual(['.*']);
  });

  it('accepts objects that strip or reject undeclared keys', () => {
    expect(findUnboundedContainers(z.object({ a: z.number() }))).toEqual([]);
    expect(findUnboundedContainers(z.strictObject({ a: z.number() }))).toEqual([]);
  });

  it('flags tuples with a rest element', () => {
    expect(findUnboundedContainers(z.tuple([z.string()]).rest(z.number()))).toEqual(['[...]']);
    expect(findUnboundedContainers(z.tuple([z.string(), z.number()]))).toEqual([]);
  });

  it('treats custom schemas as opaque', () => {
    expect(findUnboundedContainers(z.custom<number[]>(Array.isArray))).toEqual([]);
  });
});

describe('findUnboundedContainersInApi', () => {
  const api = {
    get: z.function({ input: z.tuple([z.array(z.number()), z.string()]), output: z.array(z.number()) }),
    put: z.function({ input: z.tuple([z.array(z.number()).max(1)]), output: z.void() }),
  };

  it('reports the parameters of each method', () => {
    expect(findUnboundedContainersInApi(api)).toEqual(['get(0)[]']);
  });

  it('reports return values when asked to', () => {
    expect(findUnboundedContainersInApi(api, { returnValues: true })).toEqual(['get(0)[]', 'get =>[]']);
  });
});
