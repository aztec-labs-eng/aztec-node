---
paths:
  - "**/*.{ts,tsx,mts,cts}"
---

<typescript_style>

<type_safety>
Avoid `as Type` casts; prefer type guards. Never use `as any`; if a subclass needs access to private members, change visibility to `protected`. Use branded types for common domain types (`SlotNumber`, `BlockNumber`, `EpochNumber`). Type guard functions follow `is<TypeName>` naming.
</type_safety>

<type_colocation>
Colocate type definitions with the code that uses them. Do not create new `types.ts` files unless a circular-dependency issue forces it. When adding a type used by exactly one function, declare it next to that function; when adding a type used by one class, declare it above the class. Extract to a package-level module only when at least three unrelated files need the same type.
</type_colocation>

<data_structures>
**Plain types** for simple local data with free functions + schema in same file. **Classes** for richer structs with serialization, factory, and utility methods. Avoid classes with only static methods; use free functions instead.

For classes, use these static factory methods: `from(FieldsOf<T>)` for synchronous construction, `create()` for async with validation, `fromBuffer()` / `fromString()` for deserialization, `empty()` / `random()` for testing helpers.

Use Zod for validating untrusted input. For classes, define a static `schema` getter. Use `zodFor<T>()` helper for type-safe schema definitions on plain types.

Use interfaces only when multiple implementations exist, exposing APIs to outside consumers, or needing to depend on a type without creating a runtime dependency.
</data_structures>

<error_handling>
Custom errors extend `Error` and set `this.name`. Use error hierarchies with base classes for domains. Include `public readonly` properties for error context.
</error_handling>

<class_style>
Be explicit with `private`/`public`/`protected`. Use `readonly` whenever possible. Method organization: static properties/constants → instance properties → constructor → static factory methods (`from`, `create`, `empty`, `random`) → lifecycle (`start`, `stop`) → public API → protected → private.
</class_style>

<jsdoc>
Document all classes, types, and interfaces with a JSDoc comment explaining their purpose. Document methods and properties unless meaning is obvious from the name. Skip JSDoc for trivial getters/setters, constructor-injected dependencies, and standard lifecycle methods (`start`, `stop`). Interface methods always require JSDoc.

Use `@param` and `@returns` only when parameter names or return types don't convey meaning. Keep comments concise — single-line format when possible. Avoid redundant "title" lines that repeat the name being documented.
</jsdoc>

<enums_and_unions>
Numeric enums for protocol constants that serialize to numbers. String enums for status values and event names. `as const` arrays with derived type for string literal unions. Discriminated unions with `type` field for variant types. Prefer `undefined` over `null`; use `compactArray()` from foundation to filter undefined values.
</enums_and_unions>

<resource_management>
Prefer `using`/`await using` over `try`/`finally` for cleanup of disposable resources. Use `using` for `Disposable` resources (`[Symbol.dispose](): void`), `await using` for `AsyncDisposable` resources (`[Symbol.asyncDispose](): Promise<void>`).
</resource_management>

<kv_store_transactions>
When working with `AztecAsyncKVStore`, wrap related reads and writes in `store.transactionAsync()` to ensure atomicity. Without transactions, concurrent operations can see inconsistent state (e.g., two callers both pass an `exists` check and both write).
</kv_store_transactions>

<general_style>
Prefer `const` over `let`. Prefer `async`/`await` over `.then()`/`.catch()` callbacks. Named exports only (no default exports). Explicit return types on public API methods; inferred types acceptable on private/internal methods. Only export types needed by external consumers. Avoid `const self = this`; use arrow functions.

Prefer high-level collection functions (`find`, `filter`, `map`, helpers from `foundation/src/collection/`) over imperative loops, but prefer imperative loops over `forEach` and complex `reduce`. Prefer `sum(items.map(item => item.value))` over `reduce(...)` for addition.

Simplify function arguments to single expressions where possible. Use expression bodies instead of block bodies when the block only contains a `return`. Block bodies are appropriate when the callback has multiple statements.
</general_style>

<code_duplication>
Avoid duplicating logic unless clarity benefits from keeping it inline. Same class → `private` helper. Same package → free function in a dedicated helper file. Complex logic → dedicated class. For two classes with similar behavior: if public APIs are nearly identical, use inheritance; if behavior overlaps but APIs differ, use composition.

Check `foundation` for existing utilities before reimplementing; the common ones are listed in `foundation-helpers.md`, next to this file. Extract general (non-domain) utilities to `foundation`.
</code_duplication>

<logging>
Always pass a structured context object as the second argument to log calls — not interpolated strings. The log pipeline indexes on these fields for filtering in production.

```typescript
// correct
this.log.info(`Preparing checkpoint ${checkpointNumber}`, { slot, checkpointNumber, proposer });

// wrong — context is lost to the log pipeline
this.log.info(`Preparing checkpoint ${checkpointNumber} for slot ${slot} by ${proposer}`);
```

Available levels in order: `trace`, `debug`, `verbose`, `info`, `warn`, `error`.
</logging>

<event_handling>
Use `TypedEventEmitter<TEventMap>` interface for typed events.
</event_handling>

</typescript_style>
