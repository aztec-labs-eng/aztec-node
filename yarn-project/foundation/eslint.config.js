import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import importPlugin from 'eslint-plugin-import-x';
import jsdoc from 'eslint-plugin-jsdoc';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import tsdoc from 'eslint-plugin-tsdoc';
import { globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import noAsyncDispose from './eslint-rules/no-async-dispose.js';
import noGlobalBuffer from './eslint-rules/no-global-buffer.js';
import noNonPrimitiveInCollections from './eslint-rules/no-non-primitive-in-collections.js';
import noUnsafeBrandedTypeConversion from './eslint-rules/no-unsafe-branded-type-conversion.js';
import preferBufferToHex from './eslint-rules/prefer-buffer-to-hex.js';
import preferCompactArray from './eslint-rules/prefer-compact-array.js';
import preferPromiseWithResolvers from './eslint-rules/prefer-promise-with-resolvers.js';
import preferSleep from './eslint-rules/prefer-sleep.js';
import preferSum from './eslint-rules/prefer-sum.js';
import preferTimes from './eslint-rules/prefer-times.js';
import preferUnique from './eslint-rules/prefer-unique.js';

export default [
  globalIgnores([
    '**/node_modules/**',
    '**/dest/**',
    '**/dist/**',
    '*.js',
    '**/scripts/**',
    'eslint.config.js',
    'eslint.config.*.js',
    'src/jest/*.mjs',
  ]),
  ...tseslint.config({
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      importPlugin.flatConfigs.recommended,
      importPlugin.flatConfigs.typescript,
      eslintConfigPrettier,
    ],
    settings: {
      'import-x/resolver': {
        typescript: true,
      },
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
      ecmaVersion: 2025,
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      jsdoc,
      tsdoc,
      'no-only-tests': noOnlyTests,
      importPlugin,
      'aztec-custom': {
        rules: {
          'no-async-dispose': noAsyncDispose,
          'no-global-buffer': noGlobalBuffer,
          'no-non-primitive-in-collections': noNonPrimitiveInCollections,
          'no-unsafe-branded-type-conversion': noUnsafeBrandedTypeConversion,
          'prefer-buffer-to-hex': preferBufferToHex,
          'prefer-compact-array': preferCompactArray,
          'prefer-promise-with-resolvers': preferPromiseWithResolvers,
          'prefer-sleep': preferSleep,
          'prefer-sum': preferSum,
          'prefer-times': preferTimes,
          'prefer-unique': preferUnique,
        },
      },
    },
    rules: {
      // Disabled rules
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-constant-condition': 'off',
      // Errors
      'import-x/no-cycle': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      'require-await': 'error',
      'no-console': 'error',
      curly: ['error', 'all'],
      camelcase: 'error',
      'import-x/no-relative-packages': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read environment variables with getEnv() from @aztec-labs/foundation/config/env, which also works where there is no `process`.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:buffer',
              message:
                "Import from 'buffer' instead, which a bundler can resolve to the package of that name for a browser.",
            },
            ...['util', 'node:util'].map(name => ({
              name,
              importNames: ['inspect'],
              message: "Import inspect from '@aztec-labs/foundation/inspect' instead, which also works in a browser.",
            })),
          ],
          patterns: [
            {
              group: ['dest'],
              message: 'You should not be importing from a build directory. Did you accidentally do a relative import?',
            },
          ],
        },
      ],
      'import-x/no-unresolved': [
        'error',
        {
          ignore: [
            // See https://github.com/import-js/eslint-plugin-import/issues/2703
            '@libp2p/bootstrap',
            // Seems like ignoring l1-artifacts in the eslint call messes up no-unresolved
            '@aztec-foundation/l1-artifacts',
            '@aztec-foundation/bb.js',
            // Conditional exports (browser/default) not resolved by eslint-import-resolver-typescript
            '@aztec-labs/wallets',
          ],
        },
      ],
      'import-x/no-extraneous-dependencies': 'error',
      // this unfortunately doesn't block `fit` and `fdescribe`
      'no-only-tests/no-only-tests': ['error'],
      'aztec-custom/no-async-dispose': 'error',
      'aztec-custom/no-global-buffer': 'error',
      'aztec-custom/no-non-primitive-in-collections': 'error',
      'aztec-custom/no-unsafe-branded-type-conversion': 'error',
      'aztec-custom/prefer-buffer-to-hex': 'warn',
      'aztec-custom/prefer-compact-array': 'warn',
      'aztec-custom/prefer-promise-with-resolvers': 'warn',
      'aztec-custom/prefer-sleep': 'warn',
      'aztec-custom/prefer-sum': 'warn',
      'aztec-custom/prefer-times': 'warn',
      'aztec-custom/prefer-unique': 'warn',
    },
  }),
  {
    files: ['**/*.test.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
      'no-restricted-properties': 'off',
    },
  },
];
