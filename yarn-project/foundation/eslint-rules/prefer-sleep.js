// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';
import { getSingleExpression, isGlobalIdentifier, isSynchronousFunction } from './utils.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation sleep over promises that only wait for a timeout',
  messages: {
    preferSleep: "Use sleep from '@aztec-labs/foundation/sleep' instead of wrapping setTimeout in a Promise.",
  },
  matchers: {
    NewExpression(node, { sourceCode }) {
      if (
        node.type !== 'NewExpression' ||
        !isGlobalIdentifier(sourceCode, node.callee, 'Promise') ||
        node.arguments.length !== 1
      ) {
        return;
      }
      const executor = node.arguments[0];
      if (
        !isSynchronousFunction(executor) ||
        executor.params.length !== 1 ||
        executor.params[0].type !== 'Identifier'
      ) {
        return;
      }
      const resolver = executor.params[0];
      const timeout = getSingleExpression(executor.body, true);
      if (
        timeout?.type !== 'CallExpression' ||
        timeout.optional ||
        !isGlobalIdentifier(sourceCode, timeout.callee, 'setTimeout') ||
        timeout.arguments.length < 1 ||
        timeout.arguments.length > 2 ||
        timeout.arguments.some(argument => argument.type === 'SpreadElement')
      ) {
        return;
      }
      const callback = timeout.arguments[0];
      let resolve = callback;
      if (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') {
        if (!isSynchronousFunction(callback) || callback.params.length !== 0) {
          return;
        }
        const resolution = getSingleExpression(callback.body, true);
        if (
          resolution?.type !== 'CallExpression' ||
          resolution.optional ||
          resolution.arguments.length !== 0 ||
          resolution.callee.type !== 'Identifier'
        ) {
          return;
        }
        resolve = resolution.callee;
      }
      if (resolve.type !== 'Identifier' || resolve.name !== resolver.name) {
        return;
      }
      const variable = sourceCode
        .getDeclaredVariables(executor)
        .find(variable => variable.identifiers.includes(resolver));
      if (variable?.references.length === 1 && variable.references[0].identifier === resolve) {
        return 'preferSleep';
      }
    },
  },
});
