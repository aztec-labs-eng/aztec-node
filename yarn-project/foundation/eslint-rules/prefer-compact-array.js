// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';
import {
  getSingleExpression,
  isGlobalIdentifier,
  isMethodCall,
  isParameterReference,
  isSynchronousFunction,
} from './utils.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation compactArray for removing undefined array elements',
  messages: {
    preferCompactArray:
      "Use compactArray(items) from '@aztec-labs/foundation/collection' to remove undefined elements.",
  },
  implementations: { 'collection/array.ts': ['compactArray'] },
  matchers: {
    CallExpression(node, { sourceCode, getArrayElementType }) {
      if (!isMethodCall(node, 'filter') || node.arguments.length !== 1 || !getArrayElementType(node.callee.object)) {
        return;
      }
      const callback = node.arguments[0];
      if (!isSynchronousFunction(callback) || callback.params.length !== 1) {
        return;
      }
      const predicate = getSingleExpression(callback.body);
      if (predicate?.type !== 'BinaryExpression' || predicate.operator !== '!==') {
        return;
      }
      if (
        (isParameterReference(sourceCode, predicate.left, callback, 0) &&
          isGlobalIdentifier(sourceCode, predicate.right, 'undefined')) ||
        (isParameterReference(sourceCode, predicate.right, callback, 0) &&
          isGlobalIdentifier(sourceCode, predicate.left, 'undefined'))
      ) {
        return 'preferCompactArray';
      }
    },
  },
});
