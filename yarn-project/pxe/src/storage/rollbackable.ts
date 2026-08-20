/**
 * A store holding block-indexed state that must be truncated when a chain prune (reorg) is detected.
 */
export interface Rollbackable {
  /**
   * Rolls the store back to `toBlock`: deletes all state originating from blocks strictly above it, as if nothing
   * past that block height ever happened.
   */
  rollbackToBlock(toBlock: number): Promise<void>;
}
