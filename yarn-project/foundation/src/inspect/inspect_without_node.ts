/** The key of the method through which a class controls how its instances are represented. */
export const custom = Symbol.for('nodejs.util.inspect.custom');

function hasCustomInspect(value: object): value is { [custom]: () => unknown } {
  return custom in value && typeof value[custom] === 'function';
}

function describeError(error: Error): string {
  const description = `${error.name}: ${error.message}`;
  return error.cause === undefined ? description : `${description} [cause]: ${inspectWithoutNode(error.cause)}`;
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
