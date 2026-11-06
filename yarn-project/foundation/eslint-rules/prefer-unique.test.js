import rule from './prefer-unique.js';
import { typedCase, typedRuleTester } from './test-utils.js';

typedRuleTester.run('prefer-unique', rule, {
  valid: [
    'new Set([1, 2]);',
    'Array.from(new Set("abc"));',
    'const values = new Map([[1, 2]]); [...new Set(values.values())];',
    'declare const values: readonly number[]; [...new Set(values)];',
    'function f(Set: any) { return [...new Set([1, 2])]; }',
    'function f(Array: any) { return Array.from(new Set([1, 2])); }',
    'Array.from(new Set([1, 2]), x => x * 2);',
    '[0, ...new Set([1, 2])];',
    'declare const values: any; [...new Set(values)];',
  ].map(typedCase),
  invalid: [
    '[...new Set([1, 1, 2])];',
    'Array.from(new Set([1, 1, 2]));',
    'const values = [1, 2]; [...new Set(values)];',
    'const values = [1, 2]; Array.from(new Set(values));',
    'const values: [number, number] = [1, 1]; [...new Set(values)];',
    '[...new Set([])];',
  ].map(code => ({ ...typedCase(code), errors: [{ messageId: 'preferUnique' }] })),
});
