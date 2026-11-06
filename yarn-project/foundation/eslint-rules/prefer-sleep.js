// @ts-check
import { createPreferUtilityRule } from './create-prefer-utility-rule.js';
import { getVariable } from './utils.js';

export default createPreferUtilityRule({
  description: 'Prefer foundation sleep over promises that only wait for a timeout',
  messageId: 'preferSleep',
  importFrom: '@aztec-labs/foundation/sleep',
  patterns: [
    {
      invalid: [
        'new Promise($resolve => setTimeout($resolve, $delay))',
        'new Promise($resolve => setTimeout(() => $resolve(), $delay))',
      ],
      preferred: 'sleep($delay)',
      ignoreReturnValues: true,
      guard: ({ $resolve }, { sourceCode }) =>
        $resolve.type === 'Identifier' && getVariable(sourceCode, $resolve)?.references.length === 1,
    },
    {
      invalid: [
        'new Promise($resolve => setTimeout($resolve))',
        'new Promise($resolve => setTimeout(() => $resolve()))',
      ],
      preferred: 'sleep(0)',
      ignoreReturnValues: true,
      guard: ({ $resolve }, { sourceCode }) =>
        $resolve.type === 'Identifier' && getVariable(sourceCode, $resolve)?.references.length === 1,
    },
  ],
});
