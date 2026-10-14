/** The key of the method through which a class controls how its instances are represented. */
export const custom = Symbol.for('nodejs.util.inspect.custom');

function hasCustomInspect(value: object): value is { [custom]: () => unknown } {
  return custom in value && typeof value[custom] === 'function';
}

function describeError(error: Error, seen: WeakSet<Error> = new WeakSet()): string {
  const description = `${error.name}: ${error.message}`;
  // A `cause` can point back into its own chain; tracking visited errors keeps a cycle from overflowing the stack.
  if (error.cause === undefined || seen.has(error)) {
    return description;
  }
  seen.add(error);
  const cause = error.cause instanceof Error ? describeError(error.cause, seen) : inspectWithoutNode(error.cause);
  return `${description} [cause]: ${cause}`;
}

/**
 * Returns a string representation of a value without relying on Node.js.
 *
 * Honors a class's own `[custom]` method. Any other object is represented as JSON.
 */
export function inspectWithoutNode(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  if (typeof value !== 'object' || value === null) {
    return String(value);
  }
  if (hasCustomInspect(value)) {
    return String(value[custom]());
  }
  if (value instanceof Error) {
    return describeError(value);
  }
  try {
    const json = JSON.stringify(value, (_key, nested) => (typeof nested === 'bigint' ? `${nested}n` : nested));
    return json ?? Object.prototype.toString.call(value);
  } catch {
    // Values that JSON cannot represent, such as ones with circular references.
    return Object.prototype.toString.call(value);
  }
}
