/**
 * Protocol between the main thread and the store's worker, which runs the Kv service. Every request carries a unique
 * `id`, which its response echoes.
 */
export type WorkerRequest =
  /**
   * Starts the service and opens its store: the database `path` in the OPFS pool at `poolDirectory`, or in memory
   * without one. The worker sends the service's Init itself, so a key transferred here never returns to the main
   * thread.
   */
  | { type: 'open'; id: number; path?: string; poolDirectory?: string; encryptionKey?: Uint8Array }
  /** One Kv command, as the generated client encodes it; the response is the service's answer, as bytes. */
  | { type: 'call'; id: number; bytes: Uint8Array }
  /** Ends the service and releases the pool's handles. */
  | { type: 'close'; id: number };

export type WorkerResponse =
  | { type: 'ok'; id: number; bytes?: Uint8Array }
  | { type: 'err'; id: number; message: string };
