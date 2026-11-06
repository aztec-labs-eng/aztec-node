import rule from './prefer-compact-array.js';
import { typedCase, typedRuleTester } from './test-utils.js';

typedRuleTester.run('prefer-compact-array', rule, {
  valid: [
    '[0, 1, undefined].filter(Boolean);',
    '[0, 1, null].filter(x => x !== null);',
    '[0, 1, null, undefined].filter(x => x != null);',
    '[0, 1, undefined].filter(x => x !== undefined && x > 0);',
    '[0, 1, undefined].filter(x => { x !== undefined; });',
    'function f(undefined: number) { return [1, 2].filter(x => x !== undefined); }',
    'declare const values: any; values.filter(x => x !== undefined);',
    'const values = { filter: (fn: unknown) => [] }; values.filter(x => x !== undefined);',
    'declare const values: number[] | undefined; values?.filter(x => x !== undefined);',
    'declare const values: readonly (number | undefined)[]; values.filter(x => x !== undefined);',
  ].map(typedCase),
  invalid: [
    '[0, 1, undefined].filter(x => x !== undefined);',
    '[false, 0, "", undefined].filter(x => x !== undefined);',
    '[0, 1, undefined].filter(x => undefined !== x);',
    '[0, 1, undefined].filter(x => { return x !== undefined; });',
    '[0, 1, undefined].filter(function (x) { return x !== undefined; });',
    '[0, 1, undefined].filter((x): x is number => x !== undefined);',
  ].map(code => ({ ...typedCase(code), errors: [{ messageId: 'preferCompactArray' }] })),
});
