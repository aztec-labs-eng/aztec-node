// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation unique for deduplicating an array',
  messageId: 'preferUnique',
  importFrom: '@aztec-labs/foundation/collection',
  implementations: { 'collection/array.ts': ['unique'] },
  patterns: [
    {
      invalid: ['[...new Set($items)]', 'Array.from(new Set($items))'],
      preferred: 'unique($items)',
      guard: ({ $items }, { getArrayElementType }) => !!getArrayElementType($items),
    },
  ],
});
