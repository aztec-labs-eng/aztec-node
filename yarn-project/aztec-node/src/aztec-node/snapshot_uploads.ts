import { LruMap } from '@aztec-labs/foundation/collection';
import type { SnapshotUploadStatus } from '@aztec-labs/stdlib/interfaces/client';

/** In-memory upload outcomes and mutual exclusion for a single node process. */
export class SnapshotUploads {
  private readonly operations = new LruMap<string, SnapshotUploadStatus>(100);
  private runningId: string | undefined;

  /** Returns unknown for operations whose outcome is no longer available. */
  public get(operationId: string): SnapshotUploadStatus {
    const status = this.operations.get(operationId);
    return status ? { ...status } : { state: 'unknown' };
  }

  /** Checks whether an ID already identifies an operation at this location. */
  public has(operationId: string, location: string): boolean {
    const status = this.operations.get(operationId);
    if (!status || status.state === 'unknown') {
      return false;
    }
    if (status.location !== location) {
      throw new Error('Snapshot upload operation ID already used for a different location.');
    }
    return true;
  }

  /** Marks a running operation's local capture complete, after syncing has resumed. */
  public markUploading(operationId: string): void {
    const status = this.operations.get(operationId);
    if (status?.state !== 'capturing') {
      throw new Error('Snapshot upload operation is not capturing.');
    }
    this.operations.set(operationId, { state: 'uploading', location: status.location });
  }

  /** Starts work without awaiting completion, or accepts an idempotent retry of a retained operation. */
  public start(operationId: string, location: string, upload: () => Promise<void>): void {
    if (this.has(operationId, location)) {
      return;
    }
    if (this.runningId !== undefined) {
      throw new Error('Snapshot upload already in progress. Cannot start another one until complete.');
    }
    this.runningId = operationId;
    this.operations.set(operationId, { state: 'capturing', location });
    void this.run(operationId, location, upload);
  }

  private async run(operationId: string, location: string, upload: () => Promise<void>) {
    try {
      await upload();
      this.operations.set(operationId, { state: 'succeeded', location });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.operations.set(operationId, { state: 'failed', location, error });
    } finally {
      this.runningId = undefined;
    }
  }
}
