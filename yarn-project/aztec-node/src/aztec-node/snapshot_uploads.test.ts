import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { retryFastUntil } from '@aztec-labs/foundation/retry';

import { SnapshotUploads } from './snapshot_uploads.js';

describe('SnapshotUploads', () => {
  it('tracks completion and permits reconnecting without restarting work', async () => {
    const uploads = new SnapshotUploads();
    const captured = promiseWithResolvers<void>();
    const work = promiseWithResolvers<void>();
    uploads.start('first', 'gs://bucket', async () => {
      await captured.promise;
      uploads.markUploading('first');
      await work.promise;
    });
    expect(uploads.get('first')).toEqual({ state: 'capturing', location: 'gs://bucket' });
    uploads.start('first', 'gs://bucket', () => Promise.reject(new Error('must not restart')));
    expect(() => uploads.start('second', 'gs://bucket', () => Promise.resolve())).toThrow(/in progress/);
    expect(() => uploads.start('first', 'gs://other', () => Promise.resolve())).toThrow(/different location/);
    captured.resolve();
    await retryFastUntil(() => uploads.get('first').state === 'uploading', 'snapshot capture');
    expect(uploads.get('first')).toEqual({ state: 'uploading', location: 'gs://bucket' });
    expect(() => uploads.start('second', 'gs://bucket', () => Promise.resolve())).toThrow(/in progress/);
    work.resolve();
    await retryFastUntil(() => uploads.get('first').state === 'succeeded', 'upload completion');
    expect(uploads.get('first')).toEqual({ state: 'succeeded', location: 'gs://bucket' });
    uploads.start('first', 'gs://bucket', () => Promise.reject(new Error('must not restart')));
    expect(uploads.get('first').state).toBe('succeeded');
  });

  it('reports publication failures and allows a new operation afterwards', async () => {
    const uploads = new SnapshotUploads();
    uploads.start('failed', 'gs://bucket', () => {
      uploads.markUploading('failed');
      return Promise.reject(new Error('Index write denied'));
    });
    expect(uploads.get('failed')).toEqual({ state: 'uploading', location: 'gs://bucket' });
    await retryFastUntil(() => uploads.get('failed').state === 'failed', 'upload failure');
    expect(uploads.get('failed')).toEqual({ state: 'failed', location: 'gs://bucket', error: 'Index write denied' });
    uploads.start('next', 'gs://bucket', () => Promise.resolve());
    await retryFastUntil(() => uploads.get('next').state === 'succeeded', 'next upload');
  });

  it('records synchronous failures too', async () => {
    const uploads = new SnapshotUploads();
    uploads.start('failed', 'gs://bucket', () => {
      throw new Error('Cannot create upload');
    });
    await retryFastUntil(() => uploads.get('failed').state === 'failed', 'synchronous failure');
    expect(uploads.get('failed')).toEqual({ state: 'failed', location: 'gs://bucket', error: 'Cannot create upload' });
  });

  it('forgets old outcomes without reporting success for them', async () => {
    const uploads = new SnapshotUploads();
    for (let i = 0; i < 150; i++) {
      uploads.start(String(i), 'gs://bucket', () => Promise.resolve());
      await retryFastUntil(() => uploads.get(String(i)).state === 'succeeded', 'upload completion');
    }
    expect(uploads.get('0')).toEqual({ state: 'unknown' });
    expect(uploads.get('149')).toEqual({ state: 'succeeded', location: 'gs://bucket' });
  });

  it('does not interpret missing or restarted operations as successful', () => {
    const uploads = new SnapshotUploads();
    uploads.start('first', 'gs://bucket', () => new Promise(() => {}));
    expect(uploads.get('missing')).toEqual({ state: 'unknown' });
    expect(new SnapshotUploads().get('first')).toEqual({ state: 'unknown' });
  });
});
