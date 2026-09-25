import { BlockNumber, CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import type { MerkleTreeReadOperations } from '@aztec-labs/stdlib/interfaces/server';
import { InboxMessagePrefixRef, type L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import { MerkleTreeId } from '@aztec-labs/stdlib/trees';
import { type MockProxy, mock } from 'jest-mock-extended';

import { type MockStreamingInbox, mockStreamingInbox } from '../test/utils.js';
import { CheckpointInboxConsumption, type CheckpointInboxConsumptionDeps } from './checkpoint_inbox_consumption.js';
import { type InboxEndpointResolver, PROTOCOL_INBOX_CONSUMPTION_CAPS } from './inbox_message_selection.js';

describe('CheckpointInboxConsumption', () => {
  const { perBlockCap, perCheckpointCap, maxMessagesPerBucket } = PROTOCOL_INBOX_CONSUMPTION_CAPS;
  const ceiling = BigInt(perCheckpointCap - maxMessagesPerBucket);

  let messageSource: MockProxy<L1ToL2MessageSource>;
  let inbox: MockProxy<InboxEndpointResolver>;
  let streamingInbox: MockStreamingInbox;
  let deps: CheckpointInboxConsumptionDeps;

  const leaves = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => new Fr(offset + i + 1));
  /** A far-future build deadline, in seconds, so endpoint lookups never time out unless a test wants them to. */
  const farDeadline = () => Date.now() / 1000 + 60;

  const forkAt = (size: bigint): Pick<MerkleTreeReadOperations, 'getTreeInfo'> => ({
    getTreeInfo: () =>
      Promise.resolve({ treeId: MerkleTreeId.L1_TO_L2_MESSAGE_TREE, root: Buffer.alloc(32), size, depth: 36 }),
  });

  const start = (size = 0n) => CheckpointInboxConsumption.start(forkAt(size), deps);

  /** Commits greedy non-final ranges until the cursor reaches `count`. */
  const advanceTo = async (consumption: CheckpointInboxConsumption, count: bigint) => {
    while (consumption.consumedTotalMsgCount < count) {
      const selection = await consumption.selectRange({ isFinalBlock: false, buildDeadline: farDeadline() });
      if (selection.kind !== 'consume') {
        throw new Error(`Unexpected abort ${selection.reason}`);
      }
      consumption.commit(selection.range);
    }
    expect(consumption.consumedTotalMsgCount).toEqual(count);
  };

  beforeEach(() => {
    messageSource = mock<L1ToL2MessageSource>();
    inbox = mock<InboxEndpointResolver>();
    streamingInbox = mockStreamingInbox(messageSource, inbox);
    deps = {
      messageSource,
      inbox,
      dateProvider: new DateProvider(),
      log: createLogger('sequencer:test'),
      logContext: { slot: SlotNumber(5), checkpointNumber: CheckpointNumber(3) },
    };
  });

  describe('start', () => {
    it('starts at genesis with nothing consumed', async () => {
      const consumption = await start();

      expect(consumption.checkpointStartTotalMsgCount).toEqual(0n);
      expect(consumption.consumedTotalMsgCount).toEqual(0n);
      expect(consumption.hasConsumedInThisCheckpoint).toBe(false);
      expect(consumption.toLogContext()).toEqual({
        checkpointStartTotalMsgCount: 0n,
        consumedTotalMsgCount: 0n,
        inboxRollingHash: streamingInbox.positionAt(0n).rollingHash.toString(),
      });
    });

    it('starts at the fork leaf count', async () => {
      streamingInbox.set(leaves(10));

      const consumption = await start(4n);

      expect(consumption.checkpointStartTotalMsgCount).toEqual(4n);
      expect(consumption.toLogContext().inboxRollingHash).toEqual(streamingInbox.positionAt(4n).rollingHash.toString());
    });

    it('throws when the local Inbox view has not synced the parent prefix', async () => {
      streamingInbox.set(leaves(3));

      await expect(start(5n)).rejects.toThrow(
        'Streaming inbox: cannot resolve the Inbox message prefix at cumulative total 5 (checkpoint 3); ' +
          'local Inbox view has not synced it',
      );
    });
  });

  describe('selectRange', () => {
    it('takes every observed message on a non-final block without querying L1', async () => {
      streamingInbox.set(leaves(10), []);
      const consumption = await start();

      const selection = await consumption.selectRange({ isFinalBlock: false, buildDeadline: farDeadline() });

      expect(selection).toEqual({
        kind: 'consume',
        range: { messages: leaves(10), start: streamingInbox.positionAt(0n), end: streamingInbox.positionAt(10n) },
      });
      expect(inbox.getBucketAtOrBeforeTotal).not.toHaveBeenCalled();
    });

    it('ends the final block on the live bucket end', async () => {
      streamingInbox.set(leaves(10), [4n, 7n]);
      const consumption = await start();

      const selection = await consumption.selectRange({ isFinalBlock: true, buildDeadline: farDeadline() });

      expect(selection.kind === 'consume' && selection.range.end).toEqual(streamingInbox.positionAt(7n));
    });

    it('queries the endpoint once a step would pass the threshold below the cap', async () => {
      const endpoint = ceiling + 132n;
      streamingInbox.set(leaves(perCheckpointCap - 24), [endpoint]);
      const consumption = await start();
      await advanceTo(consumption, ceiling);

      const selection = await consumption.selectRange({ isFinalBlock: false, buildDeadline: farDeadline() });

      expect(inbox.getBucketAtOrBeforeTotal).toHaveBeenCalledWith(BigInt(perCheckpointCap - 24));
      expect(selection.kind === 'consume' && selection.range.end).toEqual(streamingInbox.positionAt(endpoint));
    });

    it('takes the safe local step when a non-final block cannot resolve an endpoint', async () => {
      streamingInbox.set(leaves(perCheckpointCap - 24), []);
      const consumption = await start();
      await advanceTo(consumption, ceiling);

      const selection = await consumption.selectRange({ isFinalBlock: false, buildDeadline: farDeadline() });

      expect(selection.kind === 'consume' && selection.range.end).toEqual(streamingInbox.positionAt(ceiling));
    });

    it('aborts when the local prefix no longer matches the cursor', async () => {
      streamingInbox.set(leaves(10));
      const consumption = await start(5n);
      streamingInbox.set(leaves(10, 100));

      const selection = await consumption.selectRange({ isFinalBlock: true, buildDeadline: farDeadline() });

      expect(selection).toEqual({ kind: 'abort', reason: 'inbox_prefix_reorged', context: { upperBound: 10n } });
    });

    it('treats an endpoint lookup that runs out of time as unresolved', async () => {
      streamingInbox.set(leaves(10));
      inbox.getBucketAtOrBeforeTotal.mockReturnValue(new Promise(() => {}));
      const consumption = await start();

      const selection = await consumption.selectRange({ isFinalBlock: true, buildDeadline: Date.now() / 1000 });

      expect(selection).toEqual({
        kind: 'abort',
        reason: 'inbox_completion_unresolved',
        context: { cause: 'no_live_endpoint', upperBound: 10n, endpointTotal: undefined, localSyncedCount: 10n },
      });
    });

    it('offers the same range again until it is committed', async () => {
      streamingInbox.set(leaves(10), [6n]);
      const consumption = await start();

      const first = await consumption.selectRange({ isFinalBlock: true, buildDeadline: farDeadline() });
      const second = await consumption.selectRange({ isFinalBlock: true, buildDeadline: farDeadline() });

      expect(second).toEqual(first);
      expect(consumption.consumedTotalMsgCount).toEqual(0n);
    });

    it('re-derives an uncommitted range from the current local view', async () => {
      streamingInbox.set(leaves(10), []);
      const consumption = await start();

      const first = await consumption.selectRange({ isFinalBlock: false, buildDeadline: farDeadline() });
      streamingInbox.append(leaves(5, 10));
      const second = await consumption.selectRange({ isFinalBlock: false, buildDeadline: farDeadline() });

      expect(first.kind === 'consume' && first.range.end).toEqual(streamingInbox.positionAt(10n));
      expect(second.kind === 'consume' && second.range).toEqual({
        messages: leaves(15),
        start: streamingInbox.positionAt(0n),
        end: streamingInbox.positionAt(15n),
      });
    });

    it('decides from one read of the local view even when it advances mid-selection', async () => {
      streamingInbox.set(leaves(10), [10n]);
      const consumption = await start();
      const contextBefore = consumption.toLogContext();
      const synced = messageSource.getSyncedMessagePosition.getMockImplementation()!;
      messageSource.getSyncedMessagePosition.mockImplementation(async () => {
        const position = await synced();
        streamingInbox.append(leaves(5, 10), { closeBucket: true });
        return position;
      });

      const selection = await consumption.selectRange({ isFinalBlock: true, buildDeadline: farDeadline() });

      expect(messageSource.getSyncedMessagePosition).toHaveBeenCalledTimes(1);
      expect(inbox.getBucketAtOrBeforeTotal).toHaveBeenCalledWith(10n);
      expect(selection.kind === 'consume' && selection.range.end.totalMessageCount).toEqual(10n);
      expect(consumption.toLogContext()).toEqual(contextBefore);
    });

    it('bounds a final block by one block of messages', async () => {
      streamingInbox.set(leaves(perBlockCap + 10), [BigInt(perBlockCap + 10)]);
      const consumption = await start();

      await consumption.selectRange({ isFinalBlock: true, buildDeadline: farDeadline() });

      expect(inbox.getBucketAtOrBeforeTotal).toHaveBeenCalledWith(BigInt(perBlockCap));
    });
  });

  describe('commit', () => {
    it('advances the cursor to the range end without reading the Inbox', async () => {
      streamingInbox.set(leaves(10), []);
      const consumption = await start();
      const selection = await consumption.selectRange({ isFinalBlock: false, buildDeadline: farDeadline() });
      if (selection.kind !== 'consume') {
        throw new Error('expected a range');
      }
      messageSource.getSyncedMessagePosition.mockClear();
      messageSource.getL1ToL2MessageRange.mockClear();

      const prefixRef = consumption.commit(selection.range);

      expect(prefixRef).toEqual(InboxMessagePrefixRef.fromPosition(streamingInbox.positionAt(10n)));
      expect(consumption.consumedTotalMsgCount).toEqual(10n);
      expect(consumption.hasConsumedInThisCheckpoint).toBe(true);
      expect(messageSource.getSyncedMessagePosition).not.toHaveBeenCalled();
      expect(messageSource.getL1ToL2MessageRange).not.toHaveBeenCalled();
      expect(inbox.getBucketAtOrBeforeTotal).not.toHaveBeenCalled();
    });

    it('refuses a range that does not start at the cursor', async () => {
      streamingInbox.set(leaves(10));
      const consumption = await start();

      const stale = {
        messages: leaves(10).slice(2, 5),
        start: streamingInbox.positionAt(2n),
        end: streamingInbox.positionAt(5n),
      };

      expect(() => consumption.commit(stale)).toThrow(/cannot commit a range starting at message total 2/);
      expect(consumption.consumedTotalMsgCount).toEqual(0n);
    });

    it('refuses a range whose start hash differs from the cursor', async () => {
      streamingInbox.set(leaves(10));
      const consumption = await start(2n);
      streamingInbox.set(leaves(10, 100));

      const replaced = { messages: [], start: streamingInbox.positionAt(2n), end: streamingInbox.positionAt(2n) };

      expect(() => consumption.commit(replaced)).toThrow(/cannot commit/);
    });
  });

  describe('resolveForcedEndpoint', () => {
    const deadline = () => ({ deadline: new Date(Date.now() + 60_000), pastLastBlockBuildTime: false });

    it('builds over the range to the live bucket end, taking the deadline after reading the local view', async () => {
      streamingInbox.set(leaves(10), [4n, 9n]);
      const consumption = await start();
      await advanceTo(consumption, 10n);
      streamingInbox.append(leaves(6, 10), { closeBucket: true });
      const calls: string[] = [];
      const synced = messageSource.getSyncedMessagePosition.getMockImplementation()!;
      messageSource.getSyncedMessagePosition.mockImplementation(() => {
        calls.push('synced');
        return synced();
      });
      const bucket = inbox.getBucketAtOrBeforeTotal.getMockImplementation()!;
      inbox.getBucketAtOrBeforeTotal.mockImplementation(upperBound => {
        calls.push('bucket');
        return bucket(upperBound);
      });
      const expected = deadline();

      const decision = await consumption.resolveForcedEndpoint({
        blockNumber: BlockNumber(7),
        getDeadline: () => {
          calls.push('deadline');
          return expected;
        },
      });

      expect(calls).toEqual(['synced', 'deadline', 'bucket']);
      expect(decision).toEqual({
        kind: 'consume',
        range: { messages: leaves(6, 10), start: streamingInbox.positionAt(10n), end: streamingInbox.positionAt(16n) },
        deadline: expected.deadline,
      });
      expect(consumption.consumedTotalMsgCount).toEqual(10n);
    });

    it('needs no block when the cursor already sits on a live bucket end', async () => {
      streamingInbox.set(leaves(10), [4n]);
      const consumption = await start(4n);

      const decision = await consumption.resolveForcedEndpoint({ blockNumber: BlockNumber(7), getDeadline: deadline });

      expect(decision).toEqual({ kind: 'already-at-endpoint' });
    });

    it('maps a changed local prefix to a reorg abort', async () => {
      streamingInbox.set(leaves(10), [4n, 10n]);
      const consumption = await start(4n);
      streamingInbox.set(leaves(10, 100), [4n, 10n]);

      const decision = await consumption.resolveForcedEndpoint({ blockNumber: BlockNumber(7), getDeadline: deadline });

      expect(decision).toEqual({
        kind: 'abort',
        reason: 'inbox_prefix_reorged',
        context: { cause: 'local_prefix_changed', upperBound: 10n, endpointTotal: 10n, localSyncedCount: 10n },
      });
    });

    it('maps any other lookup failure to an unresolved completion', async () => {
      streamingInbox.set(leaves(10), [2n]);
      const consumption = await start(4n);

      const decision = await consumption.resolveForcedEndpoint({ blockNumber: BlockNumber(7), getDeadline: deadline });

      expect(decision).toEqual({
        kind: 'abort',
        reason: 'inbox_completion_unresolved',
        context: { cause: 'endpoint_behind_cursor', upperBound: 10n, endpointTotal: 2n, localSyncedCount: 10n },
      });
    });
  });
});
