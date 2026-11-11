import config, { noExtraneousDependenciesOptions } from '@aztec-labs/foundation/eslint';

export default [
  ...config,
  {
    // drift.ts runs only in the generator and the drift test, and no published entry point imports it, so prettier stays
    // a devDependency.
    files: ['src/drift.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': ['error', { ...noExtraneousDependenciesOptions, devDependencies: true }],
    },
  },
];
