import type { Archiver } from '@aztec-labs/archiver';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { BlockHash, type L2Tips } from '@aztec-labs/stdlib/block';
import { createFileStore } from '@aztec-labs/stdlib/file-store';
import type { WorldStateSynchronizer } from '@aztec-labs/stdlib/interfaces/server';
import { getSnapshotIndex, makeSnapshotPaths } from '@aztec-labs/stdlib/snapshots';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { mock } from 'jest-mock-extended';
import { tmpdir } from 'os';
import { join } from 'path';

import { captureSnapshot } from './upload-snapshot.js';

describe('captureSnapshot', () => {
  const log = createLogger('node-lib:test:captured-snapshot');
  let directory: string;
  let archiver: ReturnType<typeof mock<Archiver>>;
  let worldState: ReturnType<typeof mock<WorldStateSynchronizer>>;
  let paused: boolean;
  const rollupAddress = EthAddress.random();
  const blockHash = BlockHash.random().toString();
  const config = { l1ChainId: 1, rollupVersion: 1 };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'capture-test-'));
    archiver = mock<Archiver>();
    worldState = mock<WorldStateSynchronizer>();
    paused = false;
    archiver.stop.mockImplementation(() => {
      paused = true;
      return Promise.resolve();
    });
    archiver.resume.mockImplementation(() => {
      paused = false;
    });
    archiver.backupTo.mockImplementation(async path => {
      await mkdir(path, { recursive: true });
      const file = join(path, 'data.db');
      await writeFile(file, 'archiver');
      return file;
    });
    worldState.backupTo.mockImplementation(async path => {
      await mkdir(path, { recursive: true });
      const { archiver: _archiver, ...paths } = makeSnapshotPaths(path);
      await Promise.all(Object.values(paths).map(file => writeFile(file, 'world-state')));
      return paths;
    });
    archiver.getRollupAddress.mockResolvedValue(rollupAddress);
    archiver.getL1BlockNumber.mockReturnValue(10n);
    archiver.getL2Tips.mockImplementation(() => {
      expect(paused).toBe(true);
      return Promise.resolve(mock<L2Tips>({ proposed: { number: BlockNumber(5), hash: blockHash } }));
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('resumes syncing before returning and uploads frozen metadata, then disposes local files', async () => {
    const location = `file://${join(directory, 'published')}`;
    {
      await using snapshot = await captureSnapshot(archiver, worldState, { ...config, dataDirectory: directory }, log);
      expect(paused).toBe(false);
      archiver.getL2Tips.mockRejectedValue(new Error('Must not read live metadata during upload'));
      await snapshot.upload(location);
      const index = await getSnapshotIndex({ ...config, rollupAddress }, await createFileStore(location));
      expect(index?.snapshots[0]).toMatchObject({ l1BlockNumber: 10, l2BlockNumber: 5, l2BlockHash: blockHash });
    }
    expect(await readdir(directory)).toEqual(['published']);
  });

  it('removes captured files when upload fails', async () => {
    await expect(async () => {
      await using snapshot = await captureSnapshot(archiver, worldState, { ...config, dataDirectory: directory }, log);
      await snapshot.upload('invalid-location');
    }).rejects.toThrow(/Unknown file store/);
    expect(await readdir(directory)).toEqual([]);
    expect(paused).toBe(false);
  });

  it('resumes syncing and removes temporary files when capture fails', async () => {
    worldState.backupTo.mockRejectedValue(new Error('Disk full'));
    await expect(captureSnapshot(archiver, worldState, { ...config, dataDirectory: directory }, log)).rejects.toThrow(
      /Disk full/,
    );
    expect(paused).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });
});
