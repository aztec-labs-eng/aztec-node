import type { Blob } from '@aztec-labs/blob-lib';
import { makeRandomBlob } from '@aztec-labs/blob-lib/testing';
import { bufferToHex } from '@aztec-labs/foundation/string';
import { InMemoryFileStore } from '@aztec-labs/stdlib/file-store';
import { InMemoryMetrics } from '@aztec-labs/telemetry-client/test';
import { jest } from '@jest/globals';

import { FileStoreBlobClient } from '../filestore/filestore_blob_client.js';
import { HttpBlobClient } from './http.js';

describe('HttpBlobClient upload reliability', () => {
  let blobs: Blob[];
  let store: InMemoryFileStore;
  let uploadClient: FileStoreBlobClient;
  let telemetry: InMemoryMetrics;
  let client: HttpBlobClient;

  beforeAll(async () => {
    blobs = await Promise.all([makeRandomBlob(3), makeRandomBlob(3)]);
  });

  beforeEach(() => {
    jest.useFakeTimers();
    telemetry = new InMemoryMetrics();
    store = new InMemoryFileStore('blob-uploads');
    uploadClient = new FileStoreBlobClient(store, 'archive');
    client = new HttpBlobClient({}, { fileStoreUploadClient: uploadClient, telemetry });
  });

  afterEach(async () => {
    client.stop();
    await telemetry.stop();
    jest.restoreAllMocks();
    jest.useRealTimers();
    InMemoryFileStore.clear();
  });

  const attributes = (type: 'blobs' | 'healthcheck', status: 'success' | 'failure') => ({
    'aztec.blob_client.upload_type': type,
    'aztec.status': status,
  });

  const collectMetrics = async () => {
    const collected = telemetry.collect();
    await jest.advanceTimersByTimeAsync(0);
    return collected;
  };

  it('recovers a partially successful upload after a transient storage error', async () => {
    const failedHash = bufferToHex(blobs[1].getEthVersionedBlobHash());
    const save = store.save.bind(store);
    let failed = false;
    jest.spyOn(store, 'save').mockImplementation((path, data, options) => {
      if (path.includes(failedHash) && !failed) {
        failed = true;
        return Promise.reject(new Error('Storage temporarily unavailable'));
      }
      return save(path, data, options);
    });

    const upload = client.sendBlobsToFilestore(blobs);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(await upload).toBe(true);
    expect(await uploadClient.getBlobsByHashes(blobs.map(b => bufferToHex(b.getEthVersionedBlobHash())))).toEqual(
      blobs.map(b => b.toJSON()),
    );

    const exported = await collectMetrics();
    expect(exported['aztec.blob_client.upload_attempt_count']).toEqual(
      expect.arrayContaining([{ value: 1, attributes: attributes('blobs', 'failure') }]),
    );
    expect(exported['aztec.blob_client.upload_request_count']).toEqual(
      expect.arrayContaining([
        { value: 1, attributes: attributes('blobs', 'success') },
        { value: 0, attributes: attributes('blobs', 'failure') },
      ]),
    );
    expect(exported['aztec.blob_client.upload_duration']).toEqual(
      expect.arrayContaining([
        { value: expect.objectContaining({ count: 1 }), attributes: attributes('blobs', 'success') },
      ]),
    );
  });

  it('reports exhausted uploads without throwing or retrying indefinitely', async () => {
    jest.spyOn(store, 'save').mockRejectedValue(new Error('Storage unavailable'));

    const upload = client.sendBlobsToFilestore(blobs);
    const result = expect(upload).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(60_000);
    await result;

    expect(store.listFiles()).toEqual([]);
    const exported = await collectMetrics();
    expect(exported['aztec.blob_client.upload_request_count']).toEqual(
      expect.arrayContaining([
        { value: 0, attributes: attributes('blobs', 'success') },
        { value: 1, attributes: attributes('blobs', 'failure') },
      ]),
    );
    const failedAttempts = exported['aztec.blob_client.upload_attempt_count']?.find(
      point =>
        point.attributes['aztec.blob_client.upload_type'] === 'blobs' && point.attributes['aztec.status'] === 'failure',
    );
    expect(failedAttempts?.value).toBeGreaterThan(1);
  });

  it('retries and measures automatic uploads without blocking blob retrieval', async () => {
    const source = new FileStoreBlobClient(new InMemoryFileStore('blob-source'), 'archive');
    await source.saveBlobs(blobs);
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
    client = new HttpBlobClient({}, { fileStoreClients: [source], fileStoreUploadClient: uploadClient, telemetry });
    const hashes = blobs.map(b => b.getEthVersionedBlobHash());

    const fetched = await client.getBlobSidecar('0x1234', hashes, { l1BlockTimestamp: 1655733624n });
    expect(fetched.map(b => b.toJSON())).toEqual(blobs.map(b => b.toJSON()));

    await jest.advanceTimersByTimeAsync(60_000);
    expect(await uploadClient.getBlobsByHashes(hashes.map(bufferToHex))).toEqual(blobs.map(b => b.toJSON()));
    const exported = await collectMetrics();
    expect(exported['aztec.blob_client.upload_request_count']).toEqual(
      expect.arrayContaining([{ value: 1, attributes: attributes('blobs', 'success') }]),
    );
    expect(exported['aztec.blob_client.upload_attempt_count']).toEqual(
      expect.arrayContaining([{ value: 1, attributes: attributes('blobs', 'failure') }]),
    );
  });

  it('keeps blob retrieval successful when its background callback rejects', async () => {
    const source = new FileStoreBlobClient(new InMemoryFileStore('blob-source'), 'archive');
    await source.saveBlobs(blobs);
    client = new HttpBlobClient(
      {},
      {
        fileStoreClients: [source],
        onBlobsFetched: () => Promise.reject(new Error('Background upload failed')),
      },
    );

    const fetched = await client.getBlobSidecar(
      '0x1234',
      blobs.map(b => b.getEthVersionedBlobHash()),
      {
        l1BlockTimestamp: 1655733624n,
      },
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(fetched.map(b => b.toJSON())).toEqual(blobs.map(b => b.toJSON()));
  });

  it('retries the startup healthcheck after a transient storage error', async () => {
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('Storage temporarily unavailable'));

    const started = client.start().catch(err => err);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(await started).toBeUndefined();

    expect(await uploadClient.testConnection()).toBe(true);
    const exported = await collectMetrics();
    expect(exported['aztec.blob_client.upload_attempt_count']).toEqual(
      expect.arrayContaining([{ value: 1, attributes: attributes('healthcheck', 'failure') }]),
    );
    expect(exported['aztec.blob_client.upload_request_count']).toEqual(
      expect.arrayContaining([{ value: 1, attributes: attributes('healthcheck', 'success') }]),
    );
  });

  it('starts during a storage outage and recovers on a later periodic healthcheck', async () => {
    const save = jest.spyOn(store, 'save').mockRejectedValue(new Error('Storage unavailable'));

    const started = client.start().catch(err => err);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(await started).toBeUndefined();
    expect(await uploadClient.testConnection()).toBe(false);

    save.mockRestore();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(await uploadClient.testConnection()).toBe(true);

    const exported = await collectMetrics();
    expect(exported['aztec.blob_client.upload_request_count']).toEqual(
      expect.arrayContaining([
        { value: 1, attributes: attributes('healthcheck', 'success') },
        { value: 1, attributes: attributes('healthcheck', 'failure') },
      ]),
    );
  });
});
