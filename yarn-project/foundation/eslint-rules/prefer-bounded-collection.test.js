import { RuleTester } from 'eslint';
import { describe, it } from 'node:test';
import tseslint from 'typescript-eslint';

import rule from './prefer-bounded-collection.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run('prefer-bounded-collection', rule, {
  valid: [
    "import { LruMap } from '@aztec-labs/foundation/collection'; const cache = new LruMap(100);",
    'for (const key of map.keys()) { log(key); }',
    'const first = map.values().next().value;',
    'const iterator = map.keys(); iterator.next();',
    'map.keys().next();',
  ],
  invalid: [
    'const oldest = this.scores.keys().next().value; this.scores.delete(oldest);',
    'seen.delete(seen.keys().next().value!);',
    'if (map.size > max) { map.delete(map.keys().next().value); }',
  ].map(code => ({ code, errors: [{ messageId: 'preferBoundedCollection' }] })),
});

new RuleTester().run('prefer-bounded-collection (Espree)', rule, {
  valid: ['map.keys().next().done;'],
  invalid: ['set.delete(set.keys().next().value);'].map(code => ({
    code,
    errors: [{ messageId: 'preferBoundedCollection' }],
  })),
});
