import config from '@aztec-labs/foundation/eslint';

export default [
  ...config,
  {
    files: ['src/public/avm/testing/account_proof_fetcher.ts'],
    rules: {
      camelcase: 'off',
      'no-console': 'off',
    },
  },
];
