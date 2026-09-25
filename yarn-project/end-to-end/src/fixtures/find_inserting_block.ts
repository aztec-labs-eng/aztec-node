import type { Fr } from '@aztec-labs/aztec.js/fields';
import type { Logger } from '@aztec-labs/aztec.js/log';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { BlockNumber, type BlockNumber as BlockNumberType } from '@aztec-labs/foundation/branded-types';
import { retryUntil } from '@aztec-labs/foundation/retry';
import type { BlockHash } from '@aztec-labs/stdlib/block';

/** The node queries locating the block that inserted an L1-to-L2 message needs. */
export type InsertingBlockNodeView = Pick<
  AztecNode,
  'getL1ToL2MessageIndex' | 'getBlockNumber' | 'getBlockData' | 'getL1ToL2MessageMembershipWitness'
>;

/** The block that inserted a message, identified by hash as well as by number so a prune cannot pass as a match. */
export type InsertingBlock = {
  blockNumber: BlockNumberType;
  blockHash: BlockHash;
  checkpointNumber: number;
  index: number;
};

/** Leaves in a block's committed L1-to-L2 message tree; genesis holds none and an unknown block reports none. */
export async function committedMessageCount(
  node: Pick<AztecNode, 'getBlockData'>,
  blockNumber: number,
): Promise<bigint | undefined> {
  if (blockNumber <= 0) {
    return 0n;
  }
  const data = await node.getBlockData(BlockNumber(blockNumber));
  return data && BigInt(data.header.state.l1ToL2MessageTree.nextAvailableLeafIndex);
}

/**
 * Finds the L2 block that inserted `msgHash` into the L1-to-L2 message tree. Under the streaming Inbox a message
 * enters the tree at the first block the proposer builds after its archiver observed it, which need not be the
 * first block of a checkpoint.
 *
 * The tree is append-only, so every block built after the insertion resolves a membership witness for the message
 * just as the inserting one does: retaining membership is not inserting it, and scanning forward from a block
 * number sampled by the caller reports where the search started whenever the message was already inserted by then.
 * The block is instead located by the message's compact leaf index against the committed leaf count, which grows
 * monotonically along the chain: the inserting block is the first whose count is past the index, found by bisecting
 * the whole chain rather than trusting any sampled bound.
 *
 * The result is then confirmed at both states: the block's parent has no membership witness for the message and
 * the block itself resolves one at the message's own compact index. A chain that moves under the search (the tip
 * advancing, a prune) fails that confirmation, which is a genuine timing miss and is retried.
 *
 * A whole attempt — index lookup, tip read, bisection and the final confirmation — sits inside the retry, because
 * every historical read it makes can throw on a chain that moves under it (a prune drops the block a bisection
 * step is asking about) exactly as it can answer a stale count. Only an attempt budget exhausted by such failures
 * gives up, carrying the last failure as the cause.
 *
 * `timeoutSeconds` bounds the search's waits together, not each one: every attempt's waits share one deadline, so a
 * chain that never commits the message fails here, with the cause attached, rather than at the suite's own timeout.
 * The bisection and confirmation reads between waits are not themselves timed.
 */
export async function findInsertingBlock(
  node: InsertingBlockNodeView,
  msgHash: Fr,
  log: Logger,
  { attempts = 3, timeoutSeconds = 240 }: { attempts?: number; timeoutSeconds?: number } = {},
): Promise<InsertingBlock> {
  const deadline = { deadline: new Date(Date.now() + timeoutSeconds * 1000) };
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { leafIndex } = await retryUntil(
        async () => {
          const index = await node.getL1ToL2MessageIndex(msgHash);
          return index === undefined ? undefined : { leafIndex: index };
        },
        `node assigns a compact index to message ${msgHash.toString()}`,
        deadline,
        0.5,
      );

      // The chain holds the message once its tip's tree has grown past the message's index.
      const { tip } = await retryUntil(
        async () => {
          const tip = await node.getBlockNumber();
          const count = await committedMessageCount(node, tip);
          return count !== undefined && count > leafIndex ? { tip } : undefined;
        },
        `a block committing message ${msgHash.toString()}`,
        deadline,
        0.5,
      );

      // Bisect for the first block past the index: genesis holds no messages, the tip holds this one.
      let below = 0;
      let holding = Number(tip);
      while (holding - below > 1) {
        const middle = below + Math.floor((holding - below) / 2);
        const count = await committedMessageCount(node, middle);
        if (count !== undefined && count > leafIndex) {
          holding = middle;
        } else {
          below = middle;
        }
      }

      const blockNumber = BlockNumber(holding);
      const data = await node.getBlockData(blockNumber);
      const witness = await node.getL1ToL2MessageMembershipWitness(blockNumber, msgHash);
      const parentWitness =
        below === 0 ? undefined : await node.getL1ToL2MessageMembershipWitness(BlockNumber(below), msgHash);
      if (data !== undefined && witness !== undefined && witness[0] === leafIndex && parentWitness === undefined) {
        return {
          blockNumber,
          blockHash: data.blockHash,
          checkpointNumber: data.checkpointNumber,
          index: data.indexWithinCheckpoint,
        };
      }
      log.warn(`Block ${blockNumber} did not confirm as the one inserting ${msgHash.toString()}; searching again`, {
        attempt,
        leafIndex,
        searchedBetween: [below, holding],
        hasBlockData: data !== undefined,
        resolvedIndex: witness?.[0],
        parentHoldsMessage: parentWitness !== undefined,
      });
    } catch (err) {
      lastError = err;
      log.warn(`Search for the block inserting ${msgHash.toString()} failed; searching again`, { attempt, err });
    }
  }
  throw new Error(`Could not confirm which block inserted message ${msgHash.toString()} in ${attempts} attempts`, {
    cause: lastError,
  });
}
