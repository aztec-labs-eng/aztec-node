import { Fr } from '@aztec-labs/aztec.js/fields';

export function generateSecretKey() {
  return { secretKey: Fr.random() };
}
