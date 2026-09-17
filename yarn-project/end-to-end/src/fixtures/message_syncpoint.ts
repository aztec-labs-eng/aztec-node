import type { Logger } from '@aztec-labs/aztec.js/log';
import type { L1BlockId } from '@aztec-labs/ethereum/l1-types';
import { retryUntil } from '@aztec-labs/foundation/retry';

/** The archiver read a reorg test needs: the L1 block its stored message log was last certified against. */
export type MessageSyncpointSource = { getSyncedMessageL1Block(): Promise<L1BlockId | undefined> };

/** The L1 read a reorg test needs: the hash of the canonical block at a height, or undefined past the tip. */
export type CanonicalL1BlockHashes = { getCanonicalBlockHash(l1BlockNumber: bigint): Promise<string | undefined> };

/**
 * Waits until the archiver's message log is certified against the canonical L1 chain at or past
 * `atLeastL1BlockNumber`.
 *
 * After a placement-only reorg the message count and rolling hash are identical on both chains, so neither can say
 * which chain the stored log belongs to. The syncpoint can: it names the L1 block at which the log was last found
 * equal to the Inbox's own position. But its height alone is not evidence either — the pre-reorg syncpoint usually
 * sits *above* the block the replacement starts at, so a height test passes before any reconciliation has happened.
 * Both are therefore required: the syncpoint must have reached the height in question, and the canonical chain must
 * actually hold the block it names at that height. A syncpoint left over from the abandoned chain fails the second
 * check whether it is at the same height or higher.
 */
export async function waitForCanonicalMessageSyncpoint(
  archiver: MessageSyncpointSource,
  l1: CanonicalL1BlockHashes,
  opts: { atLeastL1BlockNumber: bigint; what: string; timeoutSeconds: number; interval?: number; logger?: Logger },
): Promise<L1BlockId> {
  return await retryUntil(
    async () => {
      const synced = await archiver.getSyncedMessageL1Block();
      if (synced === undefined || synced.l1BlockNumber < opts.atLeastL1BlockNumber) {
        return undefined;
      }
      // Undefined past the canonical tip: a syncpoint on an abandoned suffix names a height the chain no longer
      // reaches, and is not evidence of anything until the chain grows back through it with its own blocks.
      const canonical = await l1.getCanonicalBlockHash(synced.l1BlockNumber);
      if (canonical === undefined || canonical.toLowerCase() !== synced.l1BlockHash.toString().toLowerCase()) {
        opts.logger?.debug(`Message syncpoint is not on the canonical chain yet`, {
          syncedL1Block: synced.l1BlockNumber,
          syncedL1BlockHash: synced.l1BlockHash.toString(),
          canonical,
        });
        return undefined;
      }
      return synced;
    },
    opts.what,
    opts.timeoutSeconds,
    opts.interval ?? 0.2,
  );
}
