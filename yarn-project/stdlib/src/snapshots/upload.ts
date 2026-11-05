import { fromEntries, getEntries, pick } from '@aztec-labs/foundation/collection';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { createLogger } from '@aztec-labs/foundation/log';
import { makeBackoff, retry } from '@aztec-labs/foundation/retry';
import { isoDate } from '@aztec-labs/foundation/string';
import type { FileStore } from '@aztec-labs/stdlib/file-store';
import { Buffer } from 'buffer';

import { getBasePath, getSnapshotIndex, getSnapshotIndexPath } from './download.js';
import type { SnapshotDataKeys, SnapshotMetadata, SnapshotsIndex, UploadSnapshotMetadata } from './types.js';

/** Seconds to wait between attempts. Object stores such as R2 return transient 5xx errors that clear on retry. */
const DEFAULT_RETRY_BACKOFF = [5, 15, 30, 60, 120];

export type UploadSnapshotRetryOptions = {
  /** Seconds to wait between attempts. Pass an empty array to disable retries. */
  retryBackoff?: number[];
};

const log = createLogger('stdlib:snapshots:upload');

function withRetries<T>(fn: () => Promise<T>, name: string, opts: UploadSnapshotRetryOptions): Promise<T> {
  return retry(fn, name, makeBackoff(opts.retryBackoff ?? DEFAULT_RETRY_BACKOFF), log);
}

export async function uploadSnapshotData(
  localPaths: Record<SnapshotDataKeys, string>,
  schemaVersions: SnapshotMetadata['schemaVersions'],
  metadata: UploadSnapshotMetadata,
  store: FileStore,
  opts: { pathFor?: (key: SnapshotDataKeys) => string; private?: boolean } & UploadSnapshotRetryOptions = {},
): Promise<SnapshotMetadata> {
  const timestamp = Date.now();
  const date = isoDate();
  const basePath = getBasePath(metadata);
  const targetPathFor =
    opts.pathFor ?? ((key: SnapshotDataKeys) => `${basePath}/${key}-${date}-${metadata.l2BlockHash}.db`);

  const dataUrls = fromEntries(
    await Promise.all(
      getEntries(localPaths).map(
        async ([key, path]) =>
          [
            key,
            await withRetries(
              () => store.upload(targetPathFor(key), path, { compress: true, public: !opts.private }),
              `Uploading snapshot ${key}`,
              opts,
            ),
          ] as const,
      ),
    ),
  );

  return {
    ...pick(metadata, 'l1BlockNumber', 'l2BlockHash', 'l2BlockNumber'),
    schemaVersions,
    timestamp,
    dataUrls,
  };
}

export async function uploadSnapshotToIndex(
  localPaths: Record<SnapshotDataKeys, string>,
  schemaVersions: SnapshotMetadata['schemaVersions'],
  metadata: UploadSnapshotMetadata,
  store: FileStore,
  opts: UploadSnapshotRetryOptions = {},
): Promise<SnapshotMetadata> {
  const newSnapshotMetadata = await uploadSnapshotData(localPaths, schemaVersions, metadata, store, opts);

  // Re-read the index on each attempt so a retry never writes back a stale copy.
  await withRetries(
    async () => {
      const snapshotsIndex = (await getSnapshotIndex(metadata, store)) ?? createEmptyIndex(metadata);
      snapshotsIndex.snapshots.unshift(newSnapshotMetadata);

      await store.save(getSnapshotIndexPath(metadata), Buffer.from(jsonStringify(snapshotsIndex, true)), {
        public: true, // Make the index publicly accessible
        compress: false, // Ensure index.json is not gzipped
        metadata: { ['Cache-control']: 'no-store' }, // Do not cache object versions
      });
    },
    'Updating snapshot index',
    opts,
  );
  return newSnapshotMetadata;
}

function createEmptyIndex(
  metadata: Pick<SnapshotsIndex, 'l1ChainId' | 'rollupVersion' | 'rollupAddress'>,
): SnapshotsIndex {
  return {
    ...pick(metadata, 'l1ChainId', 'rollupVersion', 'rollupAddress'),
    snapshots: [],
  };
}
