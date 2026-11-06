// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';
import { isGlobalIdentifier, isMethodCall } from './utils.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation times for generating arrays from a length',
  messages: {
    preferTimes:
      "Use times from '@aztec-labs/foundation/collection' to generate an array. Its callback receives the index as its only argument.",
  },
  matchers: {
    CallExpression(node, { sourceCode }) {
      if (isMethodCall(node, 'from') && isGlobalIdentifier(sourceCode, node.callee.object, 'Array')) {
        const source = node.arguments[0];
        if (source?.type !== 'ObjectExpression' || source.properties.length !== 1) {
          return;
        }
        const property = source.properties[0];
        if (
          property.type === 'Property' &&
          property.kind === 'init' &&
          !property.computed &&
          !property.method &&
          ((property.key.type === 'Identifier' && property.key.name === 'length') ||
            (property.key.type === 'Literal' && property.key.value === 'length'))
        ) {
          return 'preferTimes';
        }
        return;
      }
      if (!isMethodCall(node, 'map')) {
        return;
      }
      const fill = node.callee.object;
      if (!isMethodCall(fill, 'fill') || fill.arguments.length !== 1) {
        return;
      }
      const array = fill.callee.object;
      if (
        (array.type === 'CallExpression' || array.type === 'NewExpression') &&
        isGlobalIdentifier(sourceCode, array.callee, 'Array') &&
        array.arguments.length === 1 &&
        array.arguments[0].type !== 'SpreadElement' &&
        array.arguments[0].type !== 'ObjectExpression' &&
        array.arguments[0].type !== 'ArrayExpression' &&
        (array.arguments[0].type !== 'Literal' || typeof array.arguments[0].value === 'number')
      ) {
        return 'preferTimes';
      }
    },
  },
});
