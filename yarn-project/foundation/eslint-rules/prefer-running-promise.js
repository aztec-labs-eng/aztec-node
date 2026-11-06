// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';

/**
 * Matches callbacks that start async work: async functions, or functions that fire a promise with `void`.
 * Synchronous ticks cannot overlap, so they stay on setInterval.
 * @param {import('estree').Node} node
 * @param {import('eslint').SourceCode['visitorKeys']} visitorKeys
 */
function startsAsyncWork(node, visitorKeys) {
  if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') {
    return false;
  }
  if (node.async) {
    return true;
  }
  /** @param {unknown} child */
  function containsVoid(child) {
    if (typeof child !== 'object' || child === null || !('type' in child) || typeof child.type !== 'string') {
      return false;
    }
    if (child.type === 'UnaryExpression' && 'operator' in child && child.operator === 'void') {
      return true;
    }
    return (visitorKeys[child.type] ?? []).some(key => [child[key]].flat().some(containsVoid));
  }
  return containsVoid(node.body);
}

export default createPreferUtilityRule({
  description: 'Prefer foundation RunningPromise over setInterval for periodic async work',
  messageId: 'preferRunningPromise',
  importFrom: '@aztec-labs/foundation/running-promise',
  message:
    "Use {{preferred}} from '{{importFrom}}' for periodic async work. setInterval starts a run while the previous one " +
    'may still be going, and nothing waits for the run in flight on stop.',
  patterns: [
    {
      invalid: 'setInterval($callback, $interval, ...$_)',
      preferred: 'new RunningPromise(fn, log, $interval)',
      guard: ({ $callback }, { sourceCode }) => startsAsyncWork($callback, sourceCode.visitorKeys),
    },
  ],
});
