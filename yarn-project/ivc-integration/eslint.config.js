import config, { noExtraneousDependenciesOptions } from '@aztec-labs/foundation/eslint';

export default [
  ...config,
  {
    // A private package: nothing here is published, so its imports may resolve through devDependencies.
    rules: {
      'import-x/no-extraneous-dependencies': ['error', { ...noExtraneousDependenciesOptions, devDependencies: true }],
    },
  },
];
