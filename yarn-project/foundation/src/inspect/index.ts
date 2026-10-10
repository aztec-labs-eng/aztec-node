import { custom, inspectWithoutNode } from './inspect_without_node.js';

// A static import of `util` cannot be resolved by a bundler targeting a browser, so the builtin is looked up at runtime.
const nodeInspect: ((value: unknown) => string) | undefined = globalThis.process?.getBuiltinModule?.('util')?.inspect;

/**
 * Returns a string representation of a value, for log and error messages.
 *
 * Where the `util` module of Node.js is available this is the output of `util.inspect`. Elsewhere it is a simpler
 * representation, which still honors a class's own `[inspect.custom]` method.
 */
export const inspect = Object.assign((value: unknown): string => (nodeInspect ?? inspectWithoutNode)(value), {
  custom,
} as const);
