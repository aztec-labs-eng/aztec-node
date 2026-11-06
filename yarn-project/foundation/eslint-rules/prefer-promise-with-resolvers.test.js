import rule from './prefer-promise-with-resolvers.js';
import { typedCase, typedRuleTester } from './test-utils.js';

typedRuleTester.run('prefer-promise-with-resolvers', rule, {
  valid: [
    'new Promise(resolve => setTimeout(resolve, 100));',
    'let done; new Promise(resolve => { done = resolve; console.log("ready"); });',
    'new Promise(resolve => { resolve = resolve; });',
    'new Promise(resolve => { resolve.saved = resolve; });',
    'new Promise(function local(resolve) { local = resolve; });',
    'new Promise(resolve => { const local = resolve; });',
    'function f(Promise: any) { let done; return new Promise(resolve => { done = resolve; }); }',
    'let done; new Promise(async resolve => { done = resolve; });',
    'let done; new Promise(resolve => { done = someOtherFunction; });',
  ].map(typedCase),
  invalid: [
    'let done; new Promise<void>(resolve => { done = resolve; });',
    'let done; new Promise<void>(resolve => done = resolve);',
    'let done, fail; new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });',
    'class Gate { resolve; promise = new Promise<void>(resolve => { this.resolve = resolve; }); }',
    'let done; new Promise<void>(function (res) { done = res; });',
  ].map(code => ({ ...typedCase(code), errors: [{ messageId: 'preferPromiseWithResolvers' }] })),
});
