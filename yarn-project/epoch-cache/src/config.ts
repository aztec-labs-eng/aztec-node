import { type L1ContractsConfig, getL1ContractsConfigEnvVars } from '@aztec-labs/ethereum/config';

export type EpochCacheConfig = Pick<L1ContractsConfig, 'ethereumSlotDuration'>;

export function getEpochCacheConfigEnvVars(): EpochCacheConfig {
  return getL1ContractsConfigEnvVars();
}
