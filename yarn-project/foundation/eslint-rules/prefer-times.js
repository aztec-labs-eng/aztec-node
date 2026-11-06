// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation times for generating arrays from a length',
  messageId: 'preferTimes',
  importFrom: '@aztec-labs/foundation/collection',
  message:
    "Use {{preferred}} from '{{importFrom}}' to generate an array. Its callback receives the index as its only argument.",
  patterns: [
    {
      invalid: 'Array.from({ length: $count }, ...$_)',
      preferred: 'times($count, index => value)',
    },
    {
      invalid: ['Array($count).fill($_).map(...$_)', 'new Array($count).fill($_).map(...$_)'],
      preferred: 'times($count, index => value)',
      guard: ({ $count }) =>
        $count.type !== 'ObjectExpression' &&
        $count.type !== 'ArrayExpression' &&
        ($count.type !== 'Literal' || typeof $count.value === 'number'),
    },
  ],
});
