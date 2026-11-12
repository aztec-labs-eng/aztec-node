The shared foundation ESLint config enables these rules as errors:

- `aztec-custom/prefer-sleep` reports promises whose executor only schedules their resolver with `setTimeout`, including
  callbacks that only call `resolve()`. Use `sleep(ms)` from `@aztec-labs/foundation/sleep`.
- `aztec-custom/prefer-running-promise` reports `setInterval` with a callback that is async or fires a promise with
  `void`. Use `new RunningPromise(fn, log, intervalMs)` from `@aztec-labs/foundation/running-promise`: `setInterval`
  starts a run while the previous one may still be going, and nothing waits for the run in flight on stop. Synchronous
  ticks are allowed.
- `aztec-custom/prefer-execute-timeout` reports promises whose executor only rejects from a `setTimeout`, optionally
  keeping the timer handle. Use `executeTimeout(signal => work(signal), ms)` from `@aztec-labs/foundation/timer`.
- `aztec-custom/prefer-timer` reports `Date.now() - start` and `performance.now() - start` when `start` is a `const`
  holding a reading of the same clock. Use `Timer` or `elapsed` from `@aztec-labs/foundation/timer`.
- `aztec-custom/prefer-bounded-collection` reports `collection.keys().next().value`, the usual way to evict the oldest
  entry of a size-capped `Map` or `Set` by hand. Use `LruMap` or `LruSet` from `@aztec-labs/foundation/collection`, or
  `FifoSet.withLimit(n)` from `@aztec-labs/foundation/fifo-set`.
- `aztec-custom/prefer-times` reports `Array.from({ length: n }, mapper)`, `Array.from({ length: n })`, and
  `Array(n).fill(value).map(mapper)` (also with `new Array`). Use `times(n, i => value)` from
  `@aztec-labs/foundation/collection`.
- `aztec-custom/prefer-compact-array` reports `.filter(item => item !== undefined)`, including explicit type predicates.
  Use `compactArray(items)` from `@aztec-labs/foundation/collection`.
- `aztec-custom/prefer-unique` reports `[...new Set(items)]` and `Array.from(new Set(items))` when `items` is an array.
  Use `unique(items)` from `@aztec-labs/foundation/collection`.
- `aztec-custom/prefer-partition` reports two adjacent `const` or `let` declarations that filter the same array with
  inline callbacks whose bodies are a predicate and its negation: `!p` and `p`, or `a === b` and `a !== b` (also `==` and
  `!=`). Use `const [pass, fail] = partition(items, predicate)` from `@aztec-labs/foundation/collection`. It skips
  receivers other than identifiers, `this` and property chains, callbacks that take the index or narrow with a type
  predicate, and filters whose result is not assigned directly, such as `.filter(p).length`.
- `aztec-custom/prefer-sum` reports addition reducers starting with `0` for numbers or `0n` for bigints.
  Use `sum(items)` from `@aztec-labs/foundation/collection` or `sumBigint(items)` from `@aztec-labs/foundation/bigint`.
- `aztec-custom/prefer-promise-with-resolvers` reports Promise executors that only assign their resolver functions to
  outer variables or properties. Use `promiseWithResolvers()` from `@aztec-labs/foundation/promise`.
- `aztec-custom/prefer-buffer-to-hex` reports a template containing just `0x` followed by `buffer.toString('hex')`.
  Use `bufferToHex(buffer)` from `@aztec-labs/foundation/string`.

The rules respect locally shadowed built-ins. Sleep promises with extra work or a retained timer handle are allowed.
Ordinary sparse arrays, `.fill(value)` without `.map()`, and `Array.from` calls that copy indexed or iterable data are
allowed. `Array({ length: n })` is also allowed: it creates a one-element array containing that object.

Rules that check array or Buffer receivers use the TypeScript program supplied by ESLint and skip unknown types.
The helpers currently accept mutable arrays, so readonly arrays, other iterables, and objects with custom methods are
allowed. String concatenation, nonzero reducer seeds, `.filter(Boolean)`, and filtering both null and undefined are
allowed. Each helper's own implementation is excluded; other functions in the same module are still checked.

There are no automatic fixes. `times` passes only the index to its callback, whereas array mapping passes the value
first. Moving a `.fill(value)` expression into a callback can also change evaluation frequency and object identity.
`times` requires a valid array length; `Array.from` also accepts lengths that need clamping or truncating.

`createPreferUtilityRule` parses each `invalid` and `preferred` expression once. The shared matcher reuses ESLint's
source AST and scope information. For example:

```js
createPreferUtilityRule({
  description: 'Prefer compactArray for removing undefined elements',
  messageId: 'preferCompactArray',
  importFrom: '@aztec-labs/foundation/collection',
  implementations: { 'collection/array.ts': ['compactArray'] },
  patterns: [{
    invalid: '$items.filter($item => $item !== undefined)',
    preferred: 'compactArray($items)',
    guard: ({ $items }, { getArrayElementType }) => !!getArrayElementType($items),
  }],
});
```

`$name` captures an expression or callback parameter. Repeated callback references must resolve to that same parameter;
literal globals such as `undefined`, `Promise`, and `Array` must be unshadowed. `$_` ignores one subtree, and `...$_`
allows unused trailing call arguments. An `invalid` array lists alternative patterns with the same preferred expression.

Type annotations, parentheses, string quote styles, and object property shorthand do not affect matching. Inline
functions accept expression bodies or one return statement, including function expressions. `ignoreReturnValues` also
allows one expression statement when callback return values are ignored, as in Promise executors and timer callbacks.
Async and generator flags, optional calls, operators, extra statements, and extra object properties remain significant.

Guards retain the checks syntax cannot establish: array and Buffer types, primitive numeric types, resolver reference
counts, and assignments to outer state. The preferred expression is rendered into the warning; it is not an autofix.

`createCodePatternRule` is the shared factory underneath `createPreferUtilityRule`. It also supports diagnostics with
no preferred expression. Supply ESLint `meta`, a `messageId` on each pattern, and a `report(captures, helpers)` callback
that returns `{ node, data }` or `false`. A `guard` may still reject a match before reporting.

`aztec-custom/no-number-string-to-decimal-parser` uses this factory to report number stringification passed to viem's
`parseGwei`, `parseEther`, and `parseUnits`. Its conversion patterns include `String($value)`, `$value.toString(...$_)`,
and a template containing only `$value`. TypeScript analysis resolves named and namespace imports and follows same-file
`const` initializers, conditional branches, and interpolations within longer templates. Decimal strings, bigint
stringification, and explicit formatting remain allowed. Mutable variables and function returns are not traced.
This rule is an error and has no automatic fix: choosing range and rounding behavior requires the caller's intent.

For example:

```ts
await new Promise(resolve => setTimeout(resolve, ms));
// becomes
await sleep(ms);

Array.from({ length: count }, (_, i) => makeItem(i));
// becomes
times(count, i => makeItem(i));
```

Run the focused rule tests from `yarn-project`:

```sh
node --test foundation/eslint-rules/*.test.js
```

`yarn test` includes them in the regular test pipeline.
