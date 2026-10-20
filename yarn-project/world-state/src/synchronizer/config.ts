import { CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import {
  type ConfigMappingsType,
  getConfigFromMappings,
  numberConfigHelper,
  optionalNumberConfigHelper,
} from '@aztec-labs/foundation/config';

/** Controls whether world-state history follows the finalized tip or retains a fixed checkpoint boundary. */
export type WorldStateHistoryRetention =
  | { type: 'rolling'; checkpoints: number }
  | { type: 'pinned'; checkpoint: CheckpointNumber }
  | { type: 'archive' };

function parseHistoryRetention(value: string): WorldStateHistoryRetention {
  if (value === 'archive') {
    return { type: 'archive' };
  }
  const match = /^(rolling|pinned):([0-9]+)$/.exec(value);
  const count = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('Expected rolling:<positive checkpoint count>, pinned:<positive checkpoint number>, or archive');
  }
  return match[1] === 'rolling'
    ? { type: 'rolling', checkpoints: count }
    : { type: 'pinned', checkpoint: CheckpointNumber(count) };
}

/** World State synchronizer configuration values. */
export interface WorldStateConfig {
  /** The frequency in which to check. */
  worldStateBlockCheckIntervalMS: number;

  /** Size of the batch for each get-blocks request from the synchronizer to the archiver. */
  worldStateBlockRequestBatchSize?: number;

  /** The map size to be provided to LMDB for each world state tree DB, optional, will inherit from the general dataStoreMapSizeKb if not specified*/
  worldStateDbMapSizeKb?: number;

  /** The map size to be provided to LMDB for each world state archive tree, optional, will inherit from the general worldStateDbMapSizeKb if not specified*/
  archiveTreeMapSizeKb?: number;

  /** The map size to be provided to LMDB for each world state nullifier tree, optional, will inherit from the general worldStateDbMapSizeKb if not specified*/
  nullifierTreeMapSizeKb?: number;

  /** The map size to be provided to LMDB for each world state note hash tree, optional, will inherit from the general worldStateDbMapSizeKb if not specified*/
  noteHashTreeMapSizeKb?: number;

  /** The map size to be provided to LMDB for each world state message tree, optional, will inherit from the general worldStateDbMapSizeKb if not specified*/
  messageTreeMapSizeKb?: number;

  /** The map size to be provided to LMDB for each world state public data tree, optional, will inherit from the general worldStateDbMapSizeKb if not specified*/
  publicDataTreeMapSizeKb?: number;

  /** Optional directory for the world state DB, if unspecified will default to the general data directory */
  worldStateDataDirectory?: string;

  /** The policy for retaining historic checkpoints. */
  worldStateHistoryRetention: WorldStateHistoryRetention;
}

export const worldStateConfigMappings: ConfigMappingsType<WorldStateConfig> = {
  worldStateBlockCheckIntervalMS: {
    env: 'WS_BLOCK_CHECK_INTERVAL_MS',
    ...numberConfigHelper(100),
    description: 'The frequency in which to check.',
  },
  worldStateBlockRequestBatchSize: {
    env: 'WS_BLOCK_REQUEST_BATCH_SIZE',
    ...optionalNumberConfigHelper(),
    description: 'Size of the batch for each get-blocks request from the synchronizer to the archiver.',
  },
  worldStateDbMapSizeKb: {
    env: 'WS_DB_MAP_SIZE_KB',
    ...optionalNumberConfigHelper(),
    description: 'The maximum possible size of the world state DB in KB. Overwrites the general dataStoreMapSizeKb.',
  },
  archiveTreeMapSizeKb: {
    env: 'ARCHIVE_TREE_MAP_SIZE_KB',
    ...optionalNumberConfigHelper(),
    description:
      'The maximum possible size of the world state archive tree in KB. Overwrites the general worldStateDbMapSizeKb.',
  },
  nullifierTreeMapSizeKb: {
    env: 'NULLIFIER_TREE_MAP_SIZE_KB',
    ...optionalNumberConfigHelper(),
    description:
      'The maximum possible size of the world state nullifier tree in KB. Overwrites the general worldStateDbMapSizeKb.',
  },
  noteHashTreeMapSizeKb: {
    env: 'NOTE_HASH_TREE_MAP_SIZE_KB',
    ...optionalNumberConfigHelper(),
    description:
      'The maximum possible size of the world state note hash tree in KB. Overwrites the general worldStateDbMapSizeKb.',
  },
  messageTreeMapSizeKb: {
    env: 'MESSAGE_TREE_MAP_SIZE_KB',
    ...optionalNumberConfigHelper(),
    description:
      'The maximum possible size of the world state message tree in KB. Overwrites the general worldStateDbMapSizeKb.',
  },
  publicDataTreeMapSizeKb: {
    env: 'PUBLIC_DATA_TREE_MAP_SIZE_KB',
    ...optionalNumberConfigHelper(),
    description:
      'The maximum possible size of the world state public data tree in KB. Overwrites the general worldStateDbMapSizeKb.',
  },
  worldStateDataDirectory: {
    env: 'WS_DATA_DIRECTORY',
    description: 'Optional directory for the world state database',
  },
  worldStateHistoryRetention: {
    env: 'WS_HISTORY_RETENTION',
    description:
      'World-state history retention: rolling:N retains N finalized checkpoints, pinned:N retains checkpoint N onwards, archive retains all history.',
    parseEnv: parseHistoryRetention,
    defaultValue: { type: 'rolling', checkpoints: 64 },
    printDefault: (value: WorldStateHistoryRetention) =>
      value.type === 'archive'
        ? 'archive'
        : value.type === 'rolling'
          ? `rolling:${value.checkpoints}`
          : `pinned:${value.checkpoint}`,
  },
};

/**
 * Returns the configuration values for the world state synchronizer.
 * @returns The configuration values for the world state synchronizer.
 */
export function getWorldStateConfigFromEnv(): WorldStateConfig {
  return getConfigFromMappings<WorldStateConfig>(worldStateConfigMappings);
}
