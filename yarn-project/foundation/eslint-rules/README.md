The shared foundation ESLint config enables these rules as warnings:

- `aztec-custom/prefer-sleep` reports promises whose executor only schedules their resolver with `setTimeout`, including
  callbacks that only call `resolve()`. Use `sleep(ms)` from `@aztec-labs/foundation/sleep`.
- `aztec-custom/prefer-times` reports `Array.from({ length: n }, mapper)`, `Array.from({ length: n })`, and
  `Array(n).fill(value).map(mapper)` (also with `new Array`). Use `times(n, i => value)` from
  `@aztec-labs/foundation/collection`.
- `aztec-custom/prefer-compact-array` reports `.filter(item => item !== undefined)`, including explicit type predicates.
  Use `compactArray(items)` from `@aztec-labs/foundation/collection`.
- `aztec-custom/prefer-unique` reports `[...new Set(items)]` and `Array.from(new Set(items))` when `items` is an array.
  Use `unique(items)` from `@aztec-labs/foundation/collection`.
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

`createPreferUtilityRule` shares rule metadata, reporting, type helpers, and implementation exclusions. Individual rules
supply AST matchers and messages showing the preferred helper call. ESLint parses the file once; the rules reuse its AST
and scope information. Matching code examples alone would not establish callback binding identity or distinguish array
methods, numeric addition, and Buffer receivers from similar-looking code with different behavior.

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
