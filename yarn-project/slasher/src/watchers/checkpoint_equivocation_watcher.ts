import { merge, pick } from '@aztec-labs/foundation/collection';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import {
  type CheckpointEquivocationDetectedEvent,
  type L2BlockSourceEventEmitter,
  L2BlockSourceEvents,
} from '@aztec-labs/stdlib/block';
import type { SlasherConfig } from '@aztec-labs/stdlib/interfaces/server';
import { OffenseType, getOffenseTypeName } from '@aztec-labs/stdlib/slashing';
import EventEmitter from 'node:events';

import { WANT_TO_SLASH_EVENT, type WantToSlashArgs, type Watcher, type WatcherEmitter } from '../watcher.js';

const CheckpointEquivocationWatcherConfigKeys = ['slashDuplicateProposalPenalty'] as const;

type CheckpointEquivocationWatcherConfig = Pick<
  SlasherConfig,
  (typeof CheckpointEquivocationWatcherConfigKeys)[number]
>;

type EquivocationEventSource = Pick<L2BlockSourceEventEmitter, 'events'>;

/**
 * Slashes a proposer for DUPLICATE_PROPOSAL when the archiver detects that a locally-stored proposed checkpoint
 * disagrees with the L1-confirmed checkpoint at the same slot. The archiver only reports this when the same key signed
 * both checkpoints, and names that key in the event, so the watcher slashes the event's signer rather than whoever the
 * committee says should have proposed the slot.
 */
export class CheckpointEquivocationWatcher extends (EventEmitter as new () => WatcherEmitter) implements Watcher {
  private readonly log: Logger = createLogger('checkpoint-equivocation-watcher');
  private readonly handler: (args: CheckpointEquivocationDetectedEvent) => void;
  private config: CheckpointEquivocationWatcherConfig;

  constructor(
    private readonly l2BlockSource: EquivocationEventSource,
    config: CheckpointEquivocationWatcherConfig,
  ) {
    super();
    this.config = pick(config, ...CheckpointEquivocationWatcherConfigKeys);
    this.handler = event => {
      try {
        this.onEquivocationDetected(event);
      } catch (err) {
        this.log.error('Failed to handle checkpoint equivocation event', err);
      }
    };
    this.log.info('CheckpointEquivocationWatcher initialized');
  }

  public updateConfig(config: Partial<CheckpointEquivocationWatcherConfig>): void {
    this.config = merge(this.config, pick(config, ...CheckpointEquivocationWatcherConfigKeys));
    this.log.verbose('CheckpointEquivocationWatcher config updated', this.config);
  }

  public start(): Promise<void> {
    this.l2BlockSource.events.on(L2BlockSourceEvents.CheckpointEquivocationDetected, this.handler);
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.l2BlockSource.events.off(L2BlockSourceEvents.CheckpointEquivocationDetected, this.handler);
    return Promise.resolve();
  }

  /** Public for tests. */
  public onEquivocationDetected(event: CheckpointEquivocationDetectedEvent): void {
    const slashArgs: WantToSlashArgs = {
      validator: event.signer,
      amount: this.config.slashDuplicateProposalPenalty,
      offenseType: OffenseType.DUPLICATE_PROPOSAL,
      epochOrSlot: BigInt(event.slotNumber),
    };

    this.log.info(`Detected checkpoint equivocation offense`, {
      slotNumber: event.slotNumber,
      checkpointNumber: event.checkpointNumber,
      amount: slashArgs.amount,
      offenseType: getOffenseTypeName(slashArgs.offenseType),
      l1ArchiveRoot: event.l1ArchiveRoot.toString(),
      proposedArchiveRoot: event.proposedArchiveRoot.toString(),
      validator: event.signer.toString(),
    });
    this.emit(WANT_TO_SLASH_EVENT, [slashArgs]);
  }
}
