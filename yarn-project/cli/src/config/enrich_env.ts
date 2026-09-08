import { EthAddress } from '@aztec-labs/aztec.js/addresses';
import type { EnvVar } from '@aztec-labs/foundation/config';

export function enrichVar(envVar: EnvVar, value: string | undefined) {
  // Don't override
  if (process.env[envVar] || value === undefined) {
    return;
  }
  process.env[envVar] = value;
}

export function enrichEthAddressVar(envVar: EnvVar, value: string) {
  // EthAddress doesn't like being given empty strings
  enrichVar(envVar, value || EthAddress.ZERO.toString());
}
