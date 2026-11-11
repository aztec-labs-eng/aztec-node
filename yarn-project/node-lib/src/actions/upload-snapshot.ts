import { ARCHIVER_DB_VERSION, type Archiver } from '@aztec-labs/archiver';
import { tryRmDir } from '@aztec-labs/foundation/fs';
import type { Logger } from '@aztec-labs/foundation/log';
import type { ChainConfig } from '@aztec-labs/stdlib/config';
import { type FileStore, createFileStore } from '@aztec-labs/stdlib/file-store';
import type { WorldStateSynchronizer } from '@aztec-labs/stdlib/interfaces/server';
import type { DataStoreConfig } from '@aztec-labs/stdlib/kv-store';
import { uploadSnapshotToIndex } from '@aztec-labs/stdlib/snapshots';
import { WORLD_STATE_DB_VERSION } from '@aztec-labs/world-state';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createBackups } from './create-backups.js';

export type UploadSnapshotConfig = Pick<ChainConfig, 'l1ChainId' | 'rollupVersion'> &
  Pick<DataStoreConfig, 'dataDirectory'>;

/** Local database copies and frozen metadata, owned until asynchronous disposal removes the temporary files. */
export interface CapturedSnapshot extends AsyncDisposable {
  /** Publishes the captured data and its index entry to the store. */
  upload(store: FileStore): Promise<void>;
}

/** Captures consistent database copies and metadata, resuming syncing before returning. Use with `await using`. */
export async function captureSnapshot(
  archiver: Archiver,
  worldState: WorldStateSynchronizer,
  config: UploadSnapshotConfig,
  log: Logger,
): Promise<CapturedSnapshot> {
  const backupDir = await mkdtemp(join(config.dataDirectory ?? tmpdir(), 'snapshot-'));
  const cleanup = async () => {
    log.info(`Cleaning up backup dir ${backupDir}`, { backupDir });
    await tryRmDir(backupDir, log);
  };

  try {
    const { paths, metadata } = await createBackups(backupDir, archiver, worldState, config, log);
    const versions = { archiver: ARCHIVER_DB_VERSION, worldState: WORLD_STATE_DB_VERSION };
    return {
      async upload(store: FileStore): Promise<void> {
        log.info(`Uploading snapshot`, { snapshot: metadata });
        const snapshot = await uploadSnapshotToIndex(paths, versions, metadata, store);
        log.info(`Snapshot uploaded successfully`, { snapshot });
      },
      [Symbol.asyncDispose]: cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Captures and publishes a snapshot, removing local copies on success or failure. */
export async function uploadSnapshot(
  location: string,
  archiver: Archiver,
  worldState: WorldStateSynchronizer,
  config: UploadSnapshotConfig,
  log: Logger,
): Promise<void> {
  const store = await createFileStore(location);
  await using snapshot = await captureSnapshot(archiver, worldState, config, log);
  await snapshot.upload(store);
}
