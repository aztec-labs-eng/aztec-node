import { RuleTester } from 'eslint';
import { describe, it } from 'node:test';
import tseslint from 'typescript-eslint';

import rule from './prefer-running-promise.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run('prefer-running-promise', rule, {
  valid: [
    "import { RunningPromise } from '@aztec-labs/foundation/running-promise'; new RunningPromise(work, log, 1000);",
    'setInterval(() => { counter++; }, 1000);',
    'setInterval(() => this.emit("tick"), 1000);',
    'setInterval(tick, 1000);',
    'setInterval(async () => await work());',
    'function poll(setInterval) { setInterval(async () => await work(), 1000); }',
    'clock.setInterval(async () => await work(), 1000);',
  ],
  invalid: [
    'setInterval(async () => { await work(); }, 1000);',
    'const id = setInterval(async () => await work(), intervalMs);',
    'setInterval(() => void work(), 1000);',
    'setInterval(() => { void work().catch(err => log.error(err)); }, 1000);',
    'setInterval(() => { if (changed()) { void handler().catch(onError); } }, 500);',
    'setInterval(async function () { await work(); }, 1000);',
    'setInterval(async () => await work(), 1000, extra);',
  ].map(code => ({ code, errors: [{ messageId: 'preferRunningPromise' }] })),
});

new RuleTester().run('prefer-running-promise (Espree)', rule, {
  valid: ['setInterval(() => tick(), 1000);'],
  invalid: ['setInterval(async () => { await work(); }, 1000);'].map(code => ({
    code,
    errors: [{ messageId: 'preferRunningPromise' }],
  })),
});
