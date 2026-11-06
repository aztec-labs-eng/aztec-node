import { RuleTester } from 'eslint';
import { describe, it } from 'node:test';
import tseslint from 'typescript-eslint';

import rule from './prefer-sleep.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run('prefer-sleep', rule, {
  valid: [
    "import { sleep } from '@aztec-labs/foundation/sleep'; await sleep(100);",
    'new Promise(resolve => emitter.once("ready", resolve));',
    'new Promise(resolve => { doWork(); setTimeout(resolve, 100); });',
    'new Promise(resolve => { const timer = setTimeout(resolve, 100); register(timer); });',
    'new Promise((resolve, reject) => setTimeout(reject, 100));',
    'new Promise(resolve => setTimeout(() => { doWork(); resolve(); }, 100));',
    'new Promise(resolve => setTimeout(() => resolve(doWork()), 100));',
    'new Promise(resolve => setTimeout(resolve, 100, doWork()));',
    'new Promise(resolve => setTimeout(otherCallback, 100));',
    'new Promise(async resolve => setTimeout(resolve, 100));',
    'new Promise(resolve => setTimeout(async () => resolve(), 100));',
    'function wait(Promise) { return new Promise(resolve => setTimeout(resolve, 100)); }',
    'function wait(setTimeout) { return new Promise(resolve => setTimeout(resolve, 100)); }',
    'new Promise(resolve => { const setTimeout = customTimer; setTimeout(resolve, 100); });',
    'new Promise(resolve => setTimeout((resolve) => resolve(), 100));',
    'new Promise(resolve => setTimeout(() => resolve(), getDelay(resolve)));',
  ],
  invalid: [
    'await new Promise(resolve => setTimeout(resolve, 100));',
    'const wait = new Promise<void>(done => setTimeout(done, duration));',
    'const wait = () => new Promise(resolve => { setTimeout(resolve, 100); });',
    'new Promise(resolve => { return setTimeout(resolve, 100); });',
    'new Promise(function (resolve) { setTimeout(resolve, 100); });',
    'new Promise(resolve => setTimeout(() => resolve(), 100));',
    'new Promise(resolve => { setTimeout(() => { resolve(); }, 100); });',
    'new Promise(resolve => setTimeout(function () { return resolve(); }, 100));',
    'new Promise(resolve => setTimeout(resolve));',
    '{ const setTimeout = customTimer; } new Promise(resolve => setTimeout(resolve, 100));',
  ].map(code => ({ code, errors: [{ messageId: 'preferSleep' }] })),
});

new RuleTester().run('prefer-sleep (Espree)', rule, {
  valid: [
    'function wait(Promise) { return new Promise(resolve => setTimeout(resolve, 100)); }',
    'new Promise(resolve => setTimeout?.(resolve, 100));',
  ],
  invalid: [
    'await new Promise(resolve => setTimeout(resolve, 100));',
    'new Promise(function (resolve) { setTimeout(() => { resolve(); }, 100); });',
  ].map(code => ({ code, errors: [{ messageId: 'preferSleep' }] })),
});
