import type { SlotNumber } from '@aztec-labs/foundation/branded-types';
import { createLogger } from '@aztec-labs/foundation/log';
import { SerialQueue } from '@aztec-labs/foundation/queue';
import type { Prettify } from '@aztec-labs/foundation/types';
import type { L1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import type { SlasherConfig } from '@aztec-labs/stdlib/interfaces/server';
import { type Offense, getOffenseTypeName, getSlotForOffense } from '@aztec-labs/stdlib/slashing';

import type { SlasherOffensesStore } from './stores/offenses_store.js';
import {
  WANT_TO_CLEAR_SLASH_EVENT,
  WANT_TO_SLASH_EVENT,
  type WantToClearSlashArgs,
  type WantToSlashArgs,
  type Watcher,
} from './watcher.js';

export type SlashOffensesCollectorConfig = Prettify<Pick<SlasherConfig, 'slashGracePeriodL2Slots'>>;
export type SlashOffensesCollectorSettings = Prettify<
  Pick<L1RollupConstants, 'epochDuration'> & {
    slashingAmounts: [bigint, bigint, bigint] | undefined;
    /** L2 slot at which the rollup was registered as canonical in the Registry. Used to anchor the slash grace period. */
    rollupRegisteredAtL2Slot: SlotNumber;
  }
>;

/**
 * Collects and manages slashable offenses from watchers.
 * This class handles the common logic for subscribing to slash watcher events,
 * storing offenses, and retrieving pending offenses for slashing.
 */
export class SlashOffensesCollector {
  private readonly unwatchCallbacks: (() => void)[] = [];
  private readonly storeMutationQueue = new SerialQueue();
  // Keyed by `${offenseType}:${epochOrSlot}`: the validators forgiven in the current round. A
  // WANT_TO_CLEAR_SLASH can be processed before the matching WANT_TO_SLASH it forgives (the slash is
  // emitted after an awaited attestation read, so a duplicate-proposal clear can enqueue first), and
  // deleting present rows alone then misses it. This forgiveness record also blocks a later add for the
  // key, so an equivocated slot's honest attesters stay forgiven regardless of order. Reset each round.
  private readonly forgivenOffenses = new Map<string, { all: boolean; validators: Set<string> }>();

  constructor(
    private config: SlashOffensesCollectorConfig,
    private readonly settings: SlashOffensesCollectorSettings,
    private readonly watchers: Watcher[],
    private readonly offensesStore: SlasherOffensesStore,
    private readonly log = createLogger('slasher:offenses-collector'),
  ) {}

  /**
   * Applies a live config update (e.g. a widened slashGracePeriodL2Slots) so newly collected
   * offenses are evaluated against the current grace window, not the value captured at startup.
   */
  public updateConfig(config: Partial<SlashOffensesCollectorConfig>) {
    this.config = { ...this.config, ...config };
  }

  public start() {
    this.log.debug('Starting SlashOffensesCollector...');
    this.storeMutationQueue.start();

    // Subscribe to watcher slashing events.
    for (const watcher of this.watchers) {
      const wantToSlashCallback = (args: WantToSlashArgs[]) =>
        this.enqueueStoreMutation('wantToSlash', () => this.handleWantToSlash(args));
      watcher.on(WANT_TO_SLASH_EVENT, wantToSlashCallback);
      this.unwatchCallbacks.push(() => watcher.removeListener(WANT_TO_SLASH_EVENT, wantToSlashCallback));

      const wantToClearSlashCallback = (args: WantToClearSlashArgs[]) =>
        this.enqueueStoreMutation('wantToClearSlash', () => this.handleWantToClearSlash(args));
      watcher.on(WANT_TO_CLEAR_SLASH_EVENT, wantToClearSlashCallback);
      this.unwatchCallbacks.push(() => watcher.removeListener(WANT_TO_CLEAR_SLASH_EVENT, wantToClearSlashCallback));
    }

    this.log.info('Started SlashOffensesCollector');
    return Promise.resolve();
  }

  public async stop() {
    this.log.debug('Stopping SlashOffensesCollector...');

    for (const unwatchCallback of this.unwatchCallbacks) {
      unwatchCallback();
    }

    await this.storeMutationQueue.end();

    this.log.info('SlashOffensesCollector stopped');
  }

  /**
   * Called when a slash watcher emits WANT_TO_SLASH_EVENT.
   * Stores pending offenses instead of creating payloads immediately.
   * @param args - the arguments from the watcher, including the validators, amounts, and offenses
   */
  public async handleWantToSlash(args: WantToSlashArgs[]) {
    for (const arg of args) {
      const offense: Offense = {
        validator: arg.validator,
        amount: arg.amount,
        offenseType: arg.offenseType,
        epochOrSlot: arg.epochOrSlot,
      };

      if (this.shouldSkipOffense(offense)) {
        this.log.verbose('Skipping offense during grace period', this.getOffenseLogData(offense));
        continue;
      }

      if (this.isForgiven(offense)) {
        this.log.verbose('Skipping offense forgiven this round', this.getOffenseLogData(offense));
        continue;
      }

      const added = await this.offensesStore.addOffense(offense);
      if (added) {
        if (this.settings.slashingAmounts) {
          const minSlash = this.settings.slashingAmounts[0];
          if (arg.amount < minSlash) {
            this.log.warn(
              `Offense amount ${arg.amount} is below minimum slashing amount ${minSlash}`,
              this.getOffenseLogData(offense),
            );
          }
        }

        this.log.info(`Adding pending offense for validator ${arg.validator}`, this.getOffenseLogData(offense));
      } else {
        this.log.debug('Skipping repeated offense', this.getOffenseLogData(offense));
      }
    }
  }

  public async handleWantToClearSlash(args: WantToClearSlashArgs[]) {
    for (const arg of args) {
      this.recordForgiveness(arg);
      const cleared = await this.offensesStore.clearOffenses(arg);
      if (cleared > 0) {
        this.log.info(`Cleared ${cleared} pending offenses`, {
          offenseType: getOffenseTypeName(arg.offenseType),
          epochOrSlot: arg.epochOrSlot,
          validators: arg.validators?.map(validator => validator.toString()),
        });
      }
    }
  }

  /**
   * Triggered on a time basis when we enter a new slashing round.
   * Clears expired offenses from stores.
   */
  public async handleNewRound(round: bigint) {
    // A new round opens a fresh forgiveness window; the previous round's forgiven keys no longer apply.
    this.forgivenOffenses.clear();
    const cleared = await this.offensesStore.clearExpiredOffenses(round);
    if (cleared && cleared > 0) {
      this.log.debug(`Cleared ${cleared} expired offenses for round ${round}`);
    }
  }

  /** Returns whether to skip an offense if it happened during the grace period after the network upgrade */
  private shouldSkipOffense(offense: Offense): boolean {
    const offenseSlot = getSlotForOffense(offense, this.settings);
    return offenseSlot < this.settings.rollupRegisteredAtL2Slot + this.config.slashGracePeriodL2Slots;
  }

  /**
   * Records a WANT_TO_CLEAR_SLASH as a forgiveness for the round so a later WANT_TO_SLASH for the same
   * key is suppressed, mirroring clearOffenses scoping: the named validators when given, else all.
   */
  private recordForgiveness(arg: WantToClearSlashArgs) {
    const key = `${arg.offenseType}:${arg.epochOrSlot}`;
    let entry = this.forgivenOffenses.get(key);
    if (!entry) {
      entry = { all: false, validators: new Set<string>() };
      this.forgivenOffenses.set(key, entry);
    }
    if (arg.validators && arg.validators.length > 0) {
      for (const validator of arg.validators) {
        entry.validators.add(validator.toString());
      }
    } else {
      entry.all = true;
    }
  }

  private isForgiven(offense: Offense): boolean {
    const entry = this.forgivenOffenses.get(`${offense.offenseType}:${offense.epochOrSlot}`);
    return entry !== undefined && (entry.all || entry.validators.has(offense.validator.toString()));
  }

  private getOffenseLogData(offense: Offense) {
    return {
      ...offense,
      validator: offense.validator.toString(),
      offenseType: getOffenseTypeName(offense.offenseType),
    };
  }

  private enqueueStoreMutation(label: string, callback: () => Promise<void>) {
    void this.storeMutationQueue.put(callback).catch(err => this.log.error(`Error handling ${label}`, err));
  }
}
