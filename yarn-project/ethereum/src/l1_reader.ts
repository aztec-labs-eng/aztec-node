import {
  type ConfigMappingsType,
  booleanConfigHelper,
  getConfigFromMappings,
  numberConfigHelper,
  optionalNumberConfigHelper,
} from '@aztec-labs/foundation/config';

import { type L1ContractAddresses, l1ContractAddressesMapping } from './l1_contract_addresses.js';

/** Configuration of the L1GlobalReader. */
export type L1ReaderConfig = {
  /** List of URLs of Ethereum RPC nodes that services will connect to (comma separated). */
  l1RpcUrls: string[];
  /** The RPC Url of the ethereum debug host for trace and debug methods. */
  l1DebugRpcUrls: string[];
  /** The chain ID of the ethereum host. */
  l1ChainId: number;
  /** The polling interval viem uses in ms */
  viemPollingIntervalMS: number;
  /** Timeout for HTTP requests to the L1 RPC node in ms. */
  l1HttpTimeoutMS?: number;
} & L1RpcGraderConfig &
  L1ContractAddresses;

/**
 * Settings of the grader that probes each L1 RPC URL and stops sending requests to the ones that lag behind or do not
 * answer. It only runs in the node, and only when two or more URLs are configured.
 */
export type L1RpcGraderConfig = {
  /** Interval in ms between rounds in which the grader asks every L1 RPC URL for its latest block number. */
  l1RpcGraderIntervalMS: number;
  /** Timeout in ms of each probe the grader sends. */
  l1RpcGraderProbeTimeoutMS: number;
  /** Blocks an L1 RPC URL may trail the highest block reported by any URL before its sample counts as lagging. */
  l1RpcGraderMaxBlocksBehind: number;
  /** Bad samples within the window that demote an L1 RPC URL, and consecutive good samples that restore it. */
  l1RpcGraderThreshold: number;
  /** Number of recent samples per L1 RPC URL the grader considers when demoting it. */
  l1RpcGraderWindow: number;
  /** Keep demoted L1 RPC URLs as a last resort after the healthy ones, instead of not using them at all. */
  l1RpcGraderKeepDemoted: boolean;
};

export const l1RpcGraderConfigMappings: ConfigMappingsType<L1RpcGraderConfig> = {
  l1RpcGraderIntervalMS: {
    env: 'ETHEREUM_HOSTS_GRADER_INTERVAL_MS',
    description:
      'Interval in ms between rounds in which the node asks every L1 RPC URL for its latest block number, to stop ' +
      'using the ones that lag behind or do not answer. Only used when two or more ETHEREUM_HOSTS are set.',
    ...numberConfigHelper(4_000),
  },
  l1RpcGraderProbeTimeoutMS: {
    env: 'ETHEREUM_HOSTS_GRADER_PROBE_TIMEOUT_MS',
    description: 'Timeout in ms of each probe the L1 RPC grader sends. A probe that times out counts as unreachable.',
    ...numberConfigHelper(1_000),
  },
  l1RpcGraderMaxBlocksBehind: {
    env: 'ETHEREUM_HOSTS_GRADER_MAX_BLOCKS_BEHIND',
    description:
      'How many blocks an L1 RPC URL may trail the highest block reported by any URL before its sample counts as ' +
      'lagging.',
    ...numberConfigHelper(2),
  },
  l1RpcGraderThreshold: {
    env: 'ETHEREUM_HOSTS_GRADER_THRESHOLD',
    description:
      'Number of bad samples (lagging or unreachable) within the window that demote an L1 RPC URL, and of ' +
      'consecutive good samples that restore it.',
    ...numberConfigHelper(3),
  },
  l1RpcGraderWindow: {
    env: 'ETHEREUM_HOSTS_GRADER_WINDOW',
    description: 'Number of recent samples per L1 RPC URL the grader looks at when deciding whether to demote it.',
    ...numberConfigHelper(3),
  },
  l1RpcGraderKeepDemoted: {
    env: 'ETHEREUM_HOSTS_GRADER_KEEP_DEMOTED',
    description:
      'Keep demoted L1 RPC URLs as a last resort, tried after the healthy ones, instead of not using them at all.',
    ...booleanConfigHelper(false),
  },
};

export const l1ReaderConfigMappings: ConfigMappingsType<L1ReaderConfig> = {
  l1ChainId: {
    env: 'L1_CHAIN_ID',
    ...optionalNumberConfigHelper(),
    description: 'The chain ID of the ethereum host.',
  },
  l1RpcUrls: {
    env: 'ETHEREUM_HOSTS',
    description: 'List of URLs of Ethereum RPC nodes that services will connect to (comma separated).',
    parseEnv: (val: string) => val.split(',').map(url => url.trim()),
    defaultValue: [],
  },
  l1DebugRpcUrls: {
    env: 'ETHEREUM_DEBUG_HOSTS',
    description: 'The RPC Url of the ethereum debug host for trace and debug methods.',
    parseEnv: (val: string) => val.split(',').map(url => url.trim()),
    defaultValue: [],
  },
  viemPollingIntervalMS: {
    env: 'L1_READER_VIEM_POLLING_INTERVAL_MS',
    description: 'The polling interval viem uses in ms',
    ...numberConfigHelper(1_000),
  },
  l1HttpTimeoutMS: {
    env: 'ETHEREUM_HTTP_TIMEOUT_MS',
    description: 'Timeout for HTTP requests to the L1 RPC node in ms.',
    ...optionalNumberConfigHelper(),
  },
  ...l1RpcGraderConfigMappings,
  ...l1ContractAddressesMapping,
};

export function getL1ReaderConfigFromEnv(): L1ReaderConfig {
  return getConfigFromMappings<L1ReaderConfig>(l1ReaderConfigMappings);
}
