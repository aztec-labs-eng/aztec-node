// @ts-check
import * as ts from 'typescript';

import { createPreferUtilityRule } from './create-prefer-utility-rule.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation sum and sumBigint for simple addition reducers',
  messageId: 'preferSum',
  importFrom: '@aztec-labs/foundation/collection',
  implementations: { 'collection/array.ts': ['sum'], 'bigint/index.ts': ['sumBigint'] },
  patterns: [
    {
      invalid: '$items.reduce(($total, $item) => $total + $item, 0)',
      preferred: 'sum($items)',
      guard: ({ $items }, { getArrayElementType, isPrimitiveType }) => {
        const element = getArrayElementType($items);
        return !!element && isPrimitiveType(element, ts.TypeFlags.NumberLike);
      },
    },
    {
      invalid: '$items.reduce(($total, $item) => $total + $item, 0n)',
      preferred: 'sumBigint($items)',
      messageId: 'preferSumBigint',
      importFrom: '@aztec-labs/foundation/bigint',
      guard: ({ $items }, { getArrayElementType, isPrimitiveType }) => {
        const element = getArrayElementType($items);
        return !!element && isPrimitiveType(element, ts.TypeFlags.BigIntLike);
      },
    },
  ],
});
