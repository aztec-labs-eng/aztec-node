import { BlockHash, inspectBlockParameter } from '@aztec-labs/stdlib/block';
import type { L2LogsSource } from '@aztec-labs/stdlib/interfaces/server';
import type {
  LogResult,
  LogsQueryBase,
  PrivateLogsQuery,
  PublicLogsQuery,
  ResolvedLogsQuery,
} from '@aztec-labs/stdlib/logs';

import type { UnseenBlockHoldOff } from './unseen_block_hold_off.js';

/**
 * Serves the node's tagged-log read queries, reducing each query's reorg-safety anchor to the concrete block hash
 * the logs source checks against.
 */
export class NodeLogsProvider {
  constructor(
    private readonly logsSource: L2LogsSource,
    private readonly holdOff: UnseenBlockHoldOff,
  ) {}

  public async getPrivateLogsByTags(query: PrivateLogsQuery): Promise<LogResult[][]> {
    return await this.logsSource.getPrivateLogsByTags(await this.#resolveReferenceBlock(query));
  }

  public async getPublicLogsByTags(query: PublicLogsQuery): Promise<LogResult[][]> {
    return await this.logsSource.getPublicLogsByTags(await this.#resolveReferenceBlock(query));
  }

  /**
   * Reduces a logs query's reorg-safety anchor to the bare block hash the logs source understands, holding the
   * request briefly when the node has not seen that block yet — a client that synced one block ahead through another
   * node is then answered instead of failed over a transient skew.
   *
   * A bare hash that never arrives is still passed on, so the logs source's own check — which runs inside the read's
   * transaction and is the authoritative one — raises the error it always did. An anchor also claims a height, and
   * nothing below here checks it, so an anchor the hold-off could not confirm fails here: handing the logs source
   * the bare hash would let a block arriving later be served without the height ever being checked.
   */
  async #resolveReferenceBlock<T extends LogsQueryBase>(query: T): Promise<ResolvedLogsQuery<T>> {
    const { referenceBlock, ...rest } = query;
    if (referenceBlock === undefined) {
      return rest as ResolvedLogsQuery<T>;
    }
    if (BlockHash.isBlockHash(referenceBlock)) {
      await this.holdOff.getBlockData({ hash: referenceBlock });
      return { ...rest, referenceBlock } as ResolvedLogsQuery<T>;
    }
    const anchor = await this.holdOff.getBlockData(referenceBlock);
    if (anchor === undefined) {
      throw new Error(
        `Reference block ${inspectBlockParameter(referenceBlock)} not found in the node. This might indicate a reorg ` +
          `has occurred.`,
      );
    }
    return { ...rest, referenceBlock: anchor.blockHash } as ResolvedLogsQuery<T>;
  }
}
