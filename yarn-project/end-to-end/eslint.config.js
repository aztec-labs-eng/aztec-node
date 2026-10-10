import base from '@aztec-labs/foundation/eslint';
import { globalIgnores } from 'eslint/config';
import globals from 'globals';

export default [
  ...base,
  // The timing test environment is loaded by jest at runtime from source (not compiled into dest),
  // and imports foundation's env across packages, so it is excluded from the TS project. Ignore it
  // from linting too, matching how foundation ignores its own src/jest/*.mjs env files.
  globalIgnores(['src/shared/timing_env.mjs']),
  {
    // Everything in this package is test code for Node.js, which sets and reads the variables of its own process.
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['src/automine/contracts/fixtures/storage_proof_fetcher.ts'],
    rules: {
      camelcase: 'off',
      'no-console': 'off',
    },
  },
];
