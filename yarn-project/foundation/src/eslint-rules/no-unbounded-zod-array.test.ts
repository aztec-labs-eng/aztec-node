import { RuleTester } from 'eslint';

// The rules live outside src as plain JS consumed by eslint.config.js, so import them by path rather than as a module
// the compiler resolves.
const rulePath = '../../eslint-rules/no-unbounded-zod-array.js';
const { default: rule } = await import(rulePath);

const ruleTester = new RuleTester();

const error = { messageId: 'unboundedArray' };

ruleTester.run('no-unbounded-zod-array', rule, {
  valid: [
    'z.array(x).max(10)',
    'z.array(x).length(4)',
    'z.array(x).min(1).max(10)',
    'z.array(x).nonempty().max(MAX_RPC_LEN)',
    'z.array(x).max(10).optional()',
    'z.array(x).max(10).transform(xs => new Set(xs))',
    'optional(z.array(x).max(10))',
    'Foo.schema.array().max(10)',
    'z.object({ items: z.array(z.array(x).max(2)).max(10) })',
    // Output schemas of a z.function parse what the server returns, not what the caller sends.
    'z.function({ input: z.tuple([]), output: z.array(x) })',
    'z.function({ input: z.tuple([]), output: z.object({ items: Foo.schema.array().optional() }) })',
    // Calls that are not zod array schemas.
    'z.string()',
    'foo.array(x)',
    'z[method](x)',
  ],
  invalid: [
    { code: 'z.array(x)', errors: [error] },
    { code: 'z.array(x).optional()', errors: [error] },
    { code: 'z.array(x).min(1)', errors: [error] },
    { code: 'z.array(x).nonempty()', errors: [error] },
    { code: 'z.array(x).optional().default([])', errors: [error] },
    { code: 'z.array(x).refine(xs => xs.length <= 10)', errors: [error] },
    { code: 'optional(z.array(x))', errors: [error] },
    { code: 'Foo.schema.array()', errors: [error] },
    { code: 'Foo.schema.array().optional()', errors: [error] },
    // Only the inner array is bounded.
    { code: 'z.array(z.array(x).max(2))', errors: [error] },
    // Only the outer array is bounded.
    { code: 'z.array(z.array(x)).max(10)', errors: [error] },
    // A bound applied later through a variable is not seen.
    { code: 'const s = z.array(x); const t = s.max(10);', errors: [error] },
    // Input schemas of a z.function are what a caller sends.
    { code: 'z.function({ input: z.tuple([z.array(x)]), output: z.void() })', errors: [error] },
    // An `output` key that does not belong to a z.function is not exempt.
    { code: 'z.object({ output: z.array(x) })', errors: [error] },
  ],
});
