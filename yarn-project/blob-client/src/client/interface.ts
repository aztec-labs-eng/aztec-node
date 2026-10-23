import type { Blob } from '@aztec-labs/blob-lib';

/**
 * Options for getBlobSidecar method.
 */
export interface GetBlobSidecarOptions {
  /**
   * True if the archiver is catching up (historical sync), false if near tip.
   * Historical sync uses a shorter retry backoff since blobs should already exist.
   */
  isHistoricalSync?: boolean;
  /**
   * The parent beacon block root for the L1 block containing the blobs.
   * Retained for callers that provide L1 block metadata; slot resolution uses the execution timestamp.
   */
  parentBeaconBlockRoot?: string;
  /**
   * The timestamp of the L1 execution block containing the blobs.
   * Skips the execution RPC lookup. Beacon configuration is fetched at startup or retried on demand.
   */
  l1BlockTimestamp?: bigint;
}

export interface BlobClientInterface {
  /** Sends the given blobs to the filestore, to be indexed by blob hash. */
  sendBlobsToFilestore(blobs: Blob[]): Promise<boolean>;
  /** Fetches the given blob sidecars by block hash and blob hashes. */
  getBlobSidecar(blockId: string, blobHashes?: Buffer[], opts?: GetBlobSidecarOptions): Promise<Blob[]>;
  /** Starts the blob client (e.g., uploads healthcheck file if not exists). */
  start?(): Promise<void>;
  /** Tests all configured blob sources and logs whether they are reachable or not. */
  testSources(): Promise<void>;
  /** Stops the blob client, clearing any periodic tasks. */
  stop?(): void;
  /** Returns true if this client can upload blobs to filestore. */
  canUpload(): boolean;
}
