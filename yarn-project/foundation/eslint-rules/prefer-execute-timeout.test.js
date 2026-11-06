import { RuleTester } from 'eslint';
import { describe, it } from 'node:test';
import tseslint from 'typescript-eslint';

import rule from './prefer-execute-timeout.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run('prefer-execute-timeout', rule, {
  valid: [
    "import { executeTimeout } from '@aztec-labs/foundation/timer'; await executeTimeout(signal => work(signal), 1000);",
    'new Promise(resolve => setTimeout(resolve, 100));',
    'new Promise((resolve, reject) => setTimeout(resolve, 100));',
    'new Promise((_, reject) => setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 100));',
    'new Promise((_, reject) => { emitter.once("error", reject); });',
    'new Promise((_, reject) => setTimeout(() => otherReject(new Error("timeout")), 100));',
    'new Promise((_, reject) => { start(); setTimeout(reject, 100); });',
    'function wait(setTimeout) { return new Promise((_, reject) => setTimeout(reject, 100)); }',
  ],
  invalid: [
    'Promise.race([work(), new Promise((_, reject) => setTimeout(reject, ms))]);',
    'new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 1000));',
    'new Promise((_resolve, reject) => { setTimeout(() => { reject(new TimeoutError()); }, 1000); });',
    'new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); });',
    'new Promise((_, reject) => { this.timer = setTimeout(reject, ms); });',
  ].map(code => ({ code, errors: [{ messageId: 'preferExecuteTimeout' }] })),
});

new RuleTester().run('prefer-execute-timeout (Espree)', rule, {
  valid: ['new Promise((_, reject) => setTimeout?.(reject, 100));'],
  invalid: ['new Promise(function (_, reject) { setTimeout(reject, 100); });'].map(code => ({
    code,
    errors: [{ messageId: 'preferExecuteTimeout' }],
  })),
});
