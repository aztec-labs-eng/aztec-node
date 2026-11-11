import {
  Attributes,
  type Histogram,
  Metrics,
  type TelemetryClient,
  type UpDownCounter,
  createUpDownCounterWithDefault,
} from '@aztec-labs/telemetry-client';

/** Kind of data being uploaded to the blob filestore. */
export type BlobUploadType = 'blobs' | 'healthcheck';

/** Records upload attempts and final outcomes separately to distinguish recovered errors from exhausted retries. */
export class BlobClientInstrumentation {
  private readonly uploadAttempts: UpDownCounter;
  private readonly uploadRequests: UpDownCounter;
  private readonly uploadDuration: Histogram;

  constructor(telemetry: TelemetryClient) {
    const meter = telemetry.getMeter('BlobClient');
    const attributes = {
      [Attributes.BLOB_CLIENT_UPLOAD_TYPE]: ['blobs', 'healthcheck'],
      [Attributes.STATUS]: ['success', 'failure'],
    };
    this.uploadAttempts = createUpDownCounterWithDefault(meter, Metrics.BLOB_CLIENT_UPLOAD_ATTEMPT_COUNT, attributes);
    this.uploadRequests = createUpDownCounterWithDefault(meter, Metrics.BLOB_CLIENT_UPLOAD_REQUEST_COUNT, attributes);
    this.uploadDuration = meter.createHistogram(Metrics.BLOB_CLIENT_UPLOAD_DURATION);
  }

  /** Records one storage attempt, including attempts that will be retried. */
  public recordAttempt(type: BlobUploadType, success: boolean): void {
    this.uploadAttempts.add(1, {
      [Attributes.BLOB_CLIENT_UPLOAD_TYPE]: type,
      [Attributes.STATUS]: success ? 'success' : 'failure',
    });
  }

  /** Records a request's final outcome and elapsed time after all retries. */
  public recordUpload(type: BlobUploadType, success: boolean, durationMs: number): void {
    const attributes = {
      [Attributes.BLOB_CLIENT_UPLOAD_TYPE]: type,
      [Attributes.STATUS]: success ? 'success' : 'failure',
    };
    this.uploadRequests.add(1, attributes);
    this.uploadDuration.record(durationMs, attributes);
  }
}
