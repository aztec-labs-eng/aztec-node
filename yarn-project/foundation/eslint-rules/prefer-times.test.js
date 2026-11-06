import { RuleTester } from 'eslint';
import { describe, it } from 'node:test';
import tseslint from 'typescript-eslint';

import rule from './prefer-times.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run('prefer-times', rule, {
  valid: [
    "import { times } from '@aztec-labs/foundation/collection'; times(5, i => i * 2);",
    'Array.from(items, item => item.value);',
    'Array.from({ length: 2, 0: "a", 1: "b" });',
    'Array.from({ length: 2, ...items });',
    'Array.from({ length: 2, [Symbol.iterator]: iterator });',
    'Array.from({ get length() { return 2; } });',
    'Array.from({ [lengthKey]: 2 });',
    'new Array(size);',
    'Array(size);',
    'Array({ length: size });',
    'new Array(size).fill(value);',
    'Array(size).fill(value, start, end).map(transform);',
    'Array(1, 2, 3).fill(0).map(transform);',
    '[1, 2, 3].map(transform);',
    'Uint8Array.from({ length: size });',
    'function generate(Array) { return Array.from({ length: size }, transform); }',
    'function generate(Array) { return new Array(size).fill(0).map(transform); }',
  ],
  invalid: [
    'Array.from({ length: 5 }, (_, i) => i * 2);',
    'Array.from({ length }, () => createItem());',
    'Array.from({ length: size });',
    'Array.from({ "length": size }, createItem);',
    'Array.from({ length: size }).map((_, i) => i);',
    'Array.from<number>({ length: size });',
    'new Array(size).fill(0).map((_, i) => i * 2);',
    'Array(size).fill(undefined).map(() => createItem());',
    'new Array<number>(size).fill(0).map((_, i) => i);',
    'Array(size).fill(0).map(transform);',
    '{ const Array = customArray; } Array.from({ length: size });',
  ].map(code => ({ code, errors: [{ messageId: 'preferTimes' }] })),
});

new RuleTester().run('prefer-times (Espree)', rule, {
  valid: [
    'function generate(Array) { return Array.from({ length: size }); }',
    'Array.from({ [lengthKey]: size });',
    'Array?.from({ length: size });',
  ],
  invalid: ['Array.from({ "length": size }, createItem);', 'new Array(size).fill(0).map((_, i) => i * 2);'].map(
    code => ({ code, errors: [{ messageId: 'preferTimes' }] }),
  ),
});
