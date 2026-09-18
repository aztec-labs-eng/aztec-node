import type { InboxContract } from '@aztec-labs/ethereum/contracts';
import type { L1BlockId } from '@aztec-labs/ethereum/l1-types';
import type { ViemPublicClient } from '@aztec-labs/ethereum/types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { type MockProxy, mock } from 'jest-mock-extended';
import type { GetBlockReturnType } from 'viem';

import type { ArchiverDataStores } from '../store/data_stores.js';
import type { MessageStore } from '../store/message_store.js';
import type { ArchiverDataStoreUpdater } from './data_store_updater.js';
import { InboxMessageSynchronizer } from './inbox_message_synchronizer.js';

describe('InboxMessageSynchronizer canonicality checks', () => {
  const head: L1BlockId = { l1BlockNumber: 100n, l1BlockHash: Buffer32.fromField(new Fr(7)) };

  /** An `eth_getBlockByNumber` answer carrying whatever the provider put in its `hash` field. */
  const blockReturning = (hash: string) => ({ number: head.l1BlockNumber, hash }) as unknown as GetBlockReturnType;

  let publicClient: MockProxy<Pick<ViemPublicClient, 'getBlock'>>;
  let inbox: MockProxy<InboxContract>;
  let messages: MockProxy<MessageStore>;
  let synchronizer: InboxMessageSynchronizer;

  beforeEach(() => {
    publicClient = mock<Pick<ViemPublicClient, 'getBlock'>>();
    inbox = mock<InboxContract>();
    messages = mock<MessageStore>();

    // An empty log whose position already equals the Inbox's, so the pass reaches the head canonicality check with
    // nothing else left to do.
    messages.getSynchedL1Block.mockResolvedValue(undefined);
    messages.getScannedL1Block.mockResolvedValue(undefined);
    messages.getSyncedMessagePosition.mockResolvedValue({ totalMessageCount: 0n, rollingHash: Fr.ZERO });
    inbox.getState.mockResolvedValue({ rollingHash: Fr.ZERO, totalMessagesInserted: 0n, currentBucketSeq: 0n });

    synchronizer = new InboxMessageSynchronizer(
      publicClient,
      inbox,
      mock<ArchiverDataStores>({ messages }),
      mock<ArchiverDataStoreUpdater>(),
      { l1BlockNumber: 1n, l1BlockHash: Buffer32.ZERO },
      () => 100n,
    );
  });

  it('confirms a head that reads back with the captured hash', async () => {
    publicClient.getBlock.mockResolvedValue(blockReturning(head.l1BlockHash.toString()));

    await expect(synchronizer.sync(head, undefined)).resolves.toMatchObject({ status: 'synced' });
  });

  it.each(['0xnot-a-block-hash', '0x1234', 'no-prefix'])(
    'leaves synchronization pending when the provider answers with the malformed hash %s',
    async hash => {
      publicClient.getBlock.mockResolvedValue(blockReturning(hash));

      await expect(synchronizer.sync(head, undefined)).resolves.toMatchObject({ status: 'pending' });
      expect(messages.setMessageSyncState).not.toHaveBeenCalled();
    },
  );
});
