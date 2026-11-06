import rule from './prefer-sum.js';
import { typedCase, typedRuleTester } from './test-utils.js';

typedRuleTester.run('prefer-sum', rule, {
  valid: [
    '["a", "b"].reduce((a, b) => a + b, "");',
    '["a", "b"].reduce((a, b) => a + b, 0);',
    '[1, 2].reduce((a, b) => a + b, 1);',
    '[1n, 2n].reduce((a, b) => a + b, 1n);',
    '[{ value: 1 }].reduce((a, b) => a + b.value, 0);',
    '[1, 2].reduce((a, b) => { a + b; }, 0);',
    '[1, 2].reduce((a, b) => { console.log(b); return a + b; }, 0);',
    '[1, 2].reduce(async (a, b) => a + b, 0);',
    'declare const values: readonly number[]; values.reduce((a, b) => a + b, 0);',
    'declare const values: any; values.reduce((a, b) => a + b, 0);',
    'const values = { reduce: (fn: unknown, seed: number) => seed }; values.reduce((a, b) => a + b, 0);',
  ].map(typedCase),
  invalid: [
    ...[
      '[1, 2].reduce((a, b) => a + b, 0);',
      'const values: number[] = []; values.reduce((total, value) => total + value, 0);',
      '[1, 2].reduce((a, b) => { return a + b; }, 0);',
      '[1, 2].reduce(function (a, b) { return a + b; }, 0);',
      'type Count = number & { readonly count: true }; declare const values: Count[]; values.reduce((a, b) => a + b, 0);',
    ].map(code => ({ ...typedCase(code), errors: [{ messageId: 'preferSum' }] })),
    ...[
      '[1n, 2n].reduce((a, b) => a + b, 0n);',
      'const values: bigint[] = []; values.reduce((total, value) => total + value, 0n);',
      '[1n, 2n].reduce((a, b) => { return a + b; }, 0n);',
    ].map(code => ({ ...typedCase(code), errors: [{ messageId: 'preferSumBigint' }] })),
  ],
});
