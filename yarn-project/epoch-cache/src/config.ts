import { type L1ContractsConfig, getL1ContractsConfigEnvVars } from '@aztec-labs/ethereum/config';
import { type L1ReaderConfig, getL1ReaderConfigFromEnv } from '@aztec-labs/ethereum/l1-reader';

export type EpochCacheConfig = Pick<
  L1ReaderConfig & L1ContractsConfig,
  'l1RpcUrls' | 'l1ChainId' | 'viemPollingIntervalMS' | 'ethereumSlotDuration' | 'l1HttpTimeoutMS'
>;

export function getEpochCacheConfigEnvVars(): EpochCacheConfig {
  return { ...getL1ReaderConfigFromEnv(), ...getL1ContractsConfigEnvVars() };
}
