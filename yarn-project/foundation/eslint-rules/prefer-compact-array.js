// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation compactArray for removing undefined array elements',
  messageId: 'preferCompactArray',
  importFrom: '@aztec-labs/foundation/collection',
  implementations: { 'collection/array.ts': ['compactArray'] },
  patterns: [
    {
      invalid: ['$items.filter($item => $item !== undefined)', '$items.filter($item => undefined !== $item)'],
      preferred: 'compactArray($items)',
      guard: ({ $items }, { getArrayElementType }) => !!getArrayElementType($items),
    },
  ],
});
