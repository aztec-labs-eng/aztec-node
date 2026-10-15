import { CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import {
  type ArchiverEmitter,
  type CheckpointEquivocationDetectedEvent,
  type L2BlockSourceEventEmitter,
  L2BlockSourceEvents,
} from '@aztec-labs/stdlib/block';
import { OffenseType } from '@aztec-labs/stdlib/slashing';
import { jest } from '@jest/globals';
import EventEmitter from 'node:events';

import { DefaultSlasherConfig, type SlasherConfig } from '../config.js';
import { WANT_TO_SLASH_EVENT, type WantToSlashArgs } from '../watcher.js';
import { CheckpointEquivocationWatcher } from './checkpoint_equivocation_watcher.js';

describe('CheckpointEquivocationWatcher', () => {
  let archiverEmitter: ArchiverEmitter;
  let l2BlockSource: Pick<L2BlockSourceEventEmitter, 'events'>;
  let config: SlasherConfig;
  let watcher: CheckpointEquivocationWatcher;
  let handler: jest.MockedFunction<(args: WantToSlashArgs[]) => void>;

  const makeEvent = (
    overrides: Partial<CheckpointEquivocationDetectedEvent> = {},
  ): CheckpointEquivocationDetectedEvent => ({
    type: L2BlockSourceEvents.CheckpointEquivocationDetected,
    slotNumber: SlotNumber(10),
    checkpointNumber: CheckpointNumber(2),
    l1ArchiveRoot: Fr.random(),
    proposedArchiveRoot: Fr.random(),
    signer: EthAddress.random(),
    ...overrides,
  });

  beforeEach(async () => {
    archiverEmitter = new EventEmitter() as unknown as ArchiverEmitter;
    l2BlockSource = { events: archiverEmitter };
    config = {
      ...DefaultSlasherConfig,
      slashDuplicateProposalPenalty: 23n,
    };
    watcher = new CheckpointEquivocationWatcher(l2BlockSource, config);
    handler = jest.fn();
    watcher.on(WANT_TO_SLASH_EVENT, handler);
    await watcher.start();
  });

  afterEach(async () => {
    await watcher.stop();
  });

  const emitAndFlush = async (event: CheckpointEquivocationDetectedEvent) => {
    archiverEmitter.emit(L2BlockSourceEvents.CheckpointEquivocationDetected, event);
    // Allow the async handler to settle.
    await new Promise(resolve => setImmediate(resolve));
  };

  it('emits a DUPLICATE_PROPOSAL slash for the signer named in the event', async () => {
    const signer = EthAddress.random();

    await emitAndFlush(makeEvent({ signer }));

    expect(handler).toHaveBeenCalledWith([
      {
        validator: signer,
        amount: 23n,
        offenseType: OffenseType.DUPLICATE_PROPOSAL,
        epochOrSlot: 10n,
      },
    ]);
  });

  it('emits a zero-amount offense when the penalty is zero', async () => {
    await watcher.stop();
    const signer = EthAddress.random();
    config = { ...config, slashDuplicateProposalPenalty: 0n };
    watcher = new CheckpointEquivocationWatcher(l2BlockSource, config);
    handler = jest.fn();
    watcher.on(WANT_TO_SLASH_EVENT, handler);
    await watcher.start();

    await emitAndFlush(makeEvent({ signer }));

    expect(handler).toHaveBeenCalledWith([
      {
        validator: signer,
        amount: 0n,
        offenseType: OffenseType.DUPLICATE_PROPOSAL,
        epochOrSlot: 10n,
      },
    ]);
  });

  it('emits separately for distinct slots', async () => {
    await emitAndFlush(makeEvent({ slotNumber: SlotNumber(10) }));
    await emitAndFlush(makeEvent({ slotNumber: SlotNumber(11) }));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0][0].epochOrSlot).toBe(10n);
    expect(handler.mock.calls[1][0][0].epochOrSlot).toBe(11n);
  });

  it('does not slash after stop()', async () => {
    await watcher.stop();
    await emitAndFlush(makeEvent());

    expect(handler).not.toHaveBeenCalled();
  });
});
