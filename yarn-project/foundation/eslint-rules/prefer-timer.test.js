import { RuleTester } from 'eslint';
import { describe, it } from 'node:test';
import tseslint from 'typescript-eslint';

import rule from './prefer-timer.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run('prefer-timer', rule, {
  valid: [
    "import { Timer } from '@aztec-labs/foundation/timer'; const timer = new Timer(); log(timer.ms());",
    'const start = Date.now(); log(performance.now() - start);',
    'const start = performance.now(); log(Date.now() - start);',
    'let start = Date.now(); start = Date.now(); log(Date.now() - start);',
    'const start = this.dateProvider.now(); log(Date.now() - start);',
    'const deadline = Date.now() + 1000; log(deadline - Date.now());',
    'log(Date.now() - this.lastSeen);',
    'log(Date.now() - block.timestamp);',
    'function f(Date) { const start = Date.now(); return Date.now() - start; }',
    'const start = Date.now(); function f(start) { return Date.now() - start; }',
  ],
  invalid: [
    'const start = Date.now(); await work(); log(Date.now() - start);',
    'const start = performance.now(); await work(); metrics.record(performance.now() - start);',
    'const localStart = performance.now(); const localTimeMs = performance.now() - localStart;',
    'const start = Date.now(); while (Date.now() - start < timeoutMs) { await tick(); }',
  ].map(code => ({ code, errors: [{ messageId: 'preferTimer' }] })),
});

new RuleTester().run('prefer-timer (Espree)', rule, {
  valid: ['var start = Date.now(); log(Date.now() - start);'],
  invalid: ['const start = Date.now(); log(Date.now() - start);'].map(code => ({
    code,
    errors: [{ messageId: 'preferTimer' }],
  })),
});
