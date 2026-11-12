import rule from './prefer-partition.js';
import { typedCase, typedRuleTester } from './test-utils.js';

const items = 'declare const items: number[]; declare function isBad(x: number): boolean;';

typedRuleTester.run('prefer-partition', rule, {
  valid: [
    // Different receivers, parameters, or predicates.
    `${items} declare const others: number[]; const good = items.filter(x => !isBad(x)); const bad = others.filter(x => isBad(x));`,
    `${items} const good = items.filter(x => !isBad(x)); const bad = items.filter(y => isBad(y));`,
    `${items} const good = items.filter(x => !isBad(x)); const bad = items.filter(x => isBad(x + 1));`,
    `${items} const good = items.filter(x => x > 0); const bad = items.filter(x => x <= 0);`,
    `${items} const good = items.filter(x => isBad(x)); const bad = items.filter(x => isBad(x));`,
    // Not adjacent declarations.
    `${items} const good = items.filter(x => !isBad(x)); items.push(1); const bad = items.filter(x => isBad(x));`,
    `${items} const good = items.filter(x => !isBad(x)).length; const bad = items.filter(x => isBad(x)).length;`,
    `${items} const counts = [items.filter(x => !isBad(x)), items.filter(x => isBad(x))];`,
    // Receivers that are not plain mutable arrays, or may evaluate differently twice.
    'declare const items: readonly number[]; const a = items.filter(x => !x); const b = items.filter(x => x);',
    'declare const items: any; const a = items.filter(x => !x); const b = items.filter(x => x);',
    'declare const items: Uint8Array; const a = items.filter(x => x === 0); const b = items.filter(x => x !== 0);',
    'declare function get(): number[]; const a = get().filter(x => !x); const b = get().filter(x => x);',
    // Callbacks that use the index, are not inline, or narrow the element type.
    `${items} const good = items.filter((x, i) => !isBad(i)); const bad = items.filter((x, i) => isBad(i));`,
    `${items} const good = items.filter(isBad); const bad = items.filter(x => !isBad(x));`,
    'declare const items: (number | undefined)[]; const a = items.filter((x): x is number => x !== undefined); const b = items.filter(x => x === undefined);',
    `${items} const good = items.filter(async x => !isBad(x)); const bad = items.filter(async x => isBad(x));`,
    `${items} var good = items.filter(x => !isBad(x)); var bad = items.filter(x => isBad(x));`,
  ].map(typedCase),
  invalid: [
    `${items} const good = items.filter(x => !isBad(x)); const bad = items.filter(x => isBad(x));`,
    `${items} const bad = items.filter(x => isBad(x)); const good = items.filter(x => !isBad(x));`,
    `${items} const good = items.filter(x => !isBad(x)), bad = items.filter(x => isBad(x));`,
    `${items} let good = items.filter(x => !(x > 0 && isBad(x))); const bad = items.filter(x => x > 0 && isBad(x));`,
    `${items} const good = items.filter(function (x) { return !isBad(x); }); const bad = items.filter(function (x) { return isBad(x); });`,
    `${items} const zero = items.filter(x => x === 0); const nonZero = items.filter(x => x !== 0);`,
    `${items} function f() { if (items.length) { const a = items.filter(x => x != 1); const b = items.filter(x => x == 1); } }`,
    'class C { items: number[] = []; isBad(x: number) { return x > 1; } f() { const good = this.items.filter(x => !this.isBad(x)); const bad = this.items.filter(x => this.isBad(x)); } }',
  ]
    .map(code => ({ ...typedCase(code), errors: [{ messageId: 'preferPartition' }] }))
    .concat({
      ...typedCase(`${items} const kept = items.filter(x => x !== 0); const dropped = items.filter(x => x === 0);`),
      errors: [
        {
          messageId: 'preferPartition',
          data: { pass: 'dropped', fail: 'kept', items: 'items', predicate: 'x => x === 0' },
        },
      ],
    }),
});
