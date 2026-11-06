// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';
import { isGlobalIdentifier, isMethodCall } from './utils.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation unique for deduplicating an array',
  messages: {
    preferUnique: "Use unique(items) from '@aztec-labs/foundation/collection' to deduplicate an array.",
  },
  implementations: { 'collection/array.ts': ['unique'] },
  matchers: {
    'ArrayExpression, CallExpression'(node, { sourceCode, getArrayElementType }) {
      let set;
      if (node.type === 'ArrayExpression' && node.elements.length === 1 && node.elements[0]?.type === 'SpreadElement') {
        set = node.elements[0].argument;
      } else if (
        isMethodCall(node, 'from') &&
        isGlobalIdentifier(sourceCode, node.callee.object, 'Array') &&
        node.arguments.length === 1
      ) {
        set = node.arguments[0];
      }
      if (
        set?.type === 'NewExpression' &&
        isGlobalIdentifier(sourceCode, set.callee, 'Set') &&
        set.arguments.length === 1 &&
        set.arguments[0].type !== 'SpreadElement' &&
        getArrayElementType(set.arguments[0])
      ) {
        return 'preferUnique';
      }
    },
  },
});
