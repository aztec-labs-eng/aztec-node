import { RuleTester } from 'eslint';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import tseslint from 'typescript-eslint';

RuleTester.describe = describe;
RuleTester.it = it;

export const typedRuleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      tsconfigRootDir: import.meta.dirname,
      projectService: { allowDefaultProject: ['rule-test.ts'], defaultProject: 'fixtures/tsconfig.json' },
    },
  },
});

/** Associates a snippet with the isolated TypeScript project used by the rule tests. */
export function typedCase(code) {
  return { code, filename: join(import.meta.dirname, 'rule-test.ts') };
}
