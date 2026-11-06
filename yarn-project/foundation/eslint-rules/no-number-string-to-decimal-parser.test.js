import rule from './no-number-string-to-decimal-parser.js';
import { typedCase, typedRuleTester } from './test-utils.js';

const viem = "import { parseGwei } from 'viem'; ";

function invalid(code, parser = 'parseGwei') {
  return { ...typedCase(code), errors: [{ messageId: 'numberString', data: { parser } }] };
}

typedRuleTester.run('no-number-string-to-decimal-parser', rule, {
  valid: [
    ...[
      'parseGwei("0.0000001");',
      'parseGwei(String(1n));',
      'parseGwei(1n.toString());',
      'parseGwei(`${1n}`);',
      'parseGwei((1e-7).toFixed(7));',
      'const amount = "0.1"; parseGwei(String(amount));',
      'const amount = "0.1"; parseGwei(amount.toString());',
      'let text = String(1e-7); parseGwei(text);',
      'const text = () => String(1e-7); parseGwei(text());',
      'function convert(parseGwei: (value: string) => bigint) { parseGwei(String(1e-7)); }',
      'const String = (_value: number) => "0.1"; parseGwei(String(1e-7));',
      'const amount = { toString: () => "0.1" }; parseGwei(amount.toString());',
      'declare const amount: any; parseGwei(String(amount));',
      'declare const amount: unknown; parseGwei(String(amount));',
      'const first = second; const second = first; parseGwei(first);',
      'parseGwei(String(1e-7, 10));',
      'parseGwei();',
    ].map(code => viem + code),
    'function parseGwei(value: string) { return value; } parseGwei(String(1e-7));',
    "import { formatGwei } from 'viem'; formatGwei(String(1e-7));",
    "import * as viem from 'viem'; function convert(viem: any) { viem.parseGwei(String(1e-7)); }",
  ].map(typedCase),
  invalid: [
    ...[
      'parseGwei(String(1e-7));',
      'parseGwei((1e-7).toString());',
      'parseGwei((1e-7).toString(10));',
      'parseGwei(`${1e-7}`);',
      'parseGwei(`0.${1e-7}0`);',
      'parseGwei(`${"0."}${1e-7}`);',
      'const text = String(1e-7); const alias = text; parseGwei(alias);',
      'const text = String(1e-7); parseGwei(`${text}`);',
      'parseGwei(true ? "0.1" : String(1e-7));',
      'parseGwei(String(String(1e-7)));',
      'const text = String(1e-7); parseGwei(text.toString());',
      'declare const amount: number | string; parseGwei(String(amount));',
      'type Amount = number & { readonly amount: true }; declare const amount: Amount; parseGwei(String(amount));',
      'function convert<T extends number>(amount: T) { return parseGwei(String(amount)); }',
      'parseGwei((String(1e-7) as string)!);',
      '(parseGwei as (value: string) => bigint)(String(1e-7));',
      'parseGwei((String(1e-7) satisfies string));',
    ].map(code => invalid(viem + code)),
    invalid("import { parseEther as amount } from 'viem'; amount(String(1e-7));", 'parseEther'),
    invalid("import { parseUnits } from 'viem/utils'; parseUnits(String(1e-7), 18);", 'parseUnits'),
    invalid("import * as units from 'viem'; units.parseEther(String(1e-7));", 'parseEther'),
    invalid("import * as units from 'viem/utils'; units['parseUnits'](String(1e-7), 18);", 'parseUnits'),
  ],
});
