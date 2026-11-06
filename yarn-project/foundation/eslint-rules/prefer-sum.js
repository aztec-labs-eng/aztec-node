// @ts-check
import * as ts from 'typescript';

import { createPreferUtilityRule } from './create-prefer-utility-rule.js';
import { getSingleExpression, isMethodCall, isParameterReference, isSynchronousFunction } from './utils.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation sum and sumBigint for simple addition reducers',
  messages: {
    preferSum: "Use sum(items) from '@aztec-labs/foundation/collection' to sum numbers.",
    preferSumBigint: "Use sumBigint(items) from '@aztec-labs/foundation/bigint' to sum bigints.",
  },
  implementations: { 'collection/array.ts': ['sum'], 'bigint/index.ts': ['sumBigint'] },
  matchers: {
    CallExpression(node, { sourceCode, getArrayElementType, isPrimitiveType }) {
      if (!isMethodCall(node, 'reduce') || node.arguments.length !== 2) {
        return;
      }
      const [callback, initial] = node.arguments;
      if (!isSynchronousFunction(callback) || callback.params.length !== 2 || initial.type !== 'Literal') {
        return;
      }
      const addition = getSingleExpression(callback.body);
      if (
        addition?.type !== 'BinaryExpression' ||
        addition.operator !== '+' ||
        !isParameterReference(sourceCode, addition.left, callback, 0) ||
        !isParameterReference(sourceCode, addition.right, callback, 1)
      ) {
        return;
      }
      const element = getArrayElementType(node.callee.object);
      if (element && initial.value === 0 && isPrimitiveType(element, ts.TypeFlags.NumberLike)) {
        return 'preferSum';
      }
      if (element && initial.value === 0n && isPrimitiveType(element, ts.TypeFlags.BigIntLike)) {
        return 'preferSumBigint';
      }
    },
  },
});
