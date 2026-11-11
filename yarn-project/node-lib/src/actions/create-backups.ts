import type { Archiver } from '@aztec-labs/archiver';
import type { Logger } from '@aztec-labs/foundation/log';
import { allToCompletion } from '@aztec-labs/foundation/promise';
import type { WorldStateSynchronizer } from '@aztec-labs/stdlib/interfaces/server';
import type { SnapshotDataUrls } from '@aztec-labs/stdlib/snapshots';
import { existsSync } from 'fs';
import { join } from 'path/posix';

import { buildSnapshotMetadata } from './build-snapshot-metadata.js';
import type { UploadSnapshotConfig } from './upload-snapshot.js';

/** Copies both databases and captures their metadata while syncing is paused, then resumes syncing. */
export async function createBackups(
  backupDir: string,
  archiver: Archiver,
  worldState: WorldStateSynchronizer,
  config: UploadSnapshotConfig,
  log: Logger,
) {
  try {
    log.info(`Pausing archiver and world state sync to start snapshot upload`);
    await archiver.stop();
    await worldState.stopSync();

    log.info(`Creating backups of lmdb environments to ${backupDir}`);
    const [archiverPath, worldStatePaths] = await allToCompletion([
      archiver.backupTo(join(backupDir, 'archiver')),
      worldState.backupTo(join(backupDir, 'world-state')),
    ]);
    const paths: SnapshotDataUrls = { ...worldStatePaths, archiver: archiverPath };

    const missing = Object.entries(paths).filter(([_key, path]) => !path || !existsSync(path));
    if (missing.length > 0) {
      throw new Error(`Missing backup files: ${missing.map(([key, path]) => `${path} (${key})`).join(', ')}`);
    }

    const metadata = await buildSnapshotMetadata(archiver, config);
    log.info(`Data stores backed up to ${backupDir}`, { paths });
    return { paths, metadata };
  } catch (err) {
    throw new Error(`Error creating backups for snapshot upload: ${err}`);
  } finally {
    log.info(`Resuming archiver and world state sync`);
    worldState.resumeSync();
    archiver.resume();
  }
}
