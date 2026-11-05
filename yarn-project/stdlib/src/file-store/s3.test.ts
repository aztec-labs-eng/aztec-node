import { HeadObjectCommand, NotFound, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { jest } from '@jest/globals';

import { S3FileStore } from './s3.js';

describe('S3FileStore', () => {
  let store: S3FileStore;
  let headError: Error | undefined;

  beforeEach(() => {
    headError = undefined;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- send's last overload is the callback form
    jest.spyOn(S3Client.prototype, 'send').mockImplementation((command: unknown) => {
      if (!(command instanceof HeadObjectCommand)) {
        throw new Error(`Unexpected command ${command}`);
      }
      return headError ? Promise.reject(headError) : Promise.resolve({});
    });
    store = new S3FileStore('bucket', 'base', { endpoint: 'http://localhost:9000' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const serviceError = (name: string, httpStatusCode: number) =>
    new S3ServiceException({
      name,
      $fault: httpStatusCode >= 500 ? 'server' : 'client',
      $metadata: { httpStatusCode },
    });

  describe('exists', () => {
    it('returns true when the object exists', async () => {
      await expect(store.exists('index.json')).resolves.toBe(true);
    });

    it('returns false when the object is not found', async () => {
      // Shape the SDK produces for a HEAD on a missing key (HEAD responses carry no error body).
      headError = new NotFound({ message: 'Unknown', $metadata: { httpStatusCode: 404 } });
      await expect(store.exists('index.json')).resolves.toBe(false);
    });

    it.each([
      ['a server error', () => serviceError('InternalError', 500)],
      ['service unavailable', () => serviceError('ServiceUnavailable', 503)],
      ['access denied', () => serviceError('Unknown', 403)],
      ['a timeout', () => Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })],
    ])('rejects on %s', async (_label, makeError) => {
      headError = makeError();
      await expect(store.exists('index.json')).rejects.toBe(headError);
    });
  });
});
