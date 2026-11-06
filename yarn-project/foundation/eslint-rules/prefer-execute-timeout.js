// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation executeTimeout over promises that only reject after a timeout',
  messageId: 'preferExecuteTimeout',
  importFrom: '@aztec-labs/foundation/timer',
  message:
    "Use {{preferred}} from '{{importFrom}}' to bound how long work may take, instead of racing it against a " +
    'promise that rejects on a timer. Pass the signal down so the work can stop.',
  patterns: [
    {
      invalid: [
        'new Promise(($_, $reject) => setTimeout($reject, $ms))',
        'new Promise(($_, $reject) => setTimeout(() => $reject(...$_), $ms))',
        'new Promise(($_, $reject) => { $timer = setTimeout($reject, $ms); })',
        'new Promise(($_, $reject) => { $timer = setTimeout(() => $reject(...$_), $ms); })',
      ],
      preferred: "executeTimeout(signal => work(signal), $ms, 'name')",
      ignoreReturnValues: true,
    },
  ],
});
