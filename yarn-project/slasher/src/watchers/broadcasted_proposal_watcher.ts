import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { SlotNumber } from '@aztec-labs/foundation/branded-types';
import { merge, pick } from '@aztec-labs/foundation/collection';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import type { P2PClient, SlasherConfig } from '@aztec-labs/stdlib/interfaces/server';
import type { BlockProposal, CheckpointProposalCore } from '@aztec-labs/stdlib/p2p';
import { OffenseType, getOffenseTypeName } from '@aztec-labs/stdlib/slashing';
import EventEmitter from 'node:events';

import { WANT_TO_SLASH_EVENT, type WantToSlashArgs, type Watcher, type WatcherEmitter } from '../watcher.js';

const BroadcastedProposalWatcherConfigKeys = [
  'slashBroadcastedInvalidCheckpointProposalPenalty',
  'slashDuplicateProposalPenalty',
] as const;

const SCAN_SLOT_LAG = 1;
const DEFAULT_SCAN_SLOT_LOOKBACK = 4;

type BroadcastedProposalWatcherConfig = Pick<SlasherConfig, (typeof BroadcastedProposalWatcherConfigKeys)[number]>;

type ProposalsForSlot = Awaited<ReturnType<P2PClient['getProposalsForSlot']>>;
type P2PProposalsForSlotSource = Pick<P2PClient, 'getProposalsForSlot'>;

type SignedBlockProposal = {
  proposal: BlockProposal;
  signer: EthAddress;
};

/**
 * Detects offenses in retained signed P2P proposals once their slot has closed: truncated checkpoint proposals, and
 * duplicate proposals, where one signer signed two different payloads for the same block index or for the slot's
 * checkpoint. Offenses are attributed to the signer recovered from each proposal, so payloads from different signers
 * at the same position are never counted against each other.
 */
export class BroadcastedProposalWatcher extends (EventEmitter as new () => WatcherEmitter) implements Watcher {
  private readonly log: Logger = createLogger('broadcasted-proposal-watcher');
  private readonly runningPromise: RunningPromise;
  /**
   * Keys of offenses already emitted, by slot. Several signers can offend in one slot, so entries are pruned as their
   * slot leaves the scan window rather than capped at a fixed count, which could evict a slot that is still rescanned.
   */
  private readonly emittedOffensesBySlot = new Map<SlotNumber, Set<string>>();
  /** Slots below this one had their emitted offenses pruned and are not scanned again. */
  private emittedOffensesPrunedBefore: SlotNumber | undefined;
  private readonly scanSlotLookback: number;
  private config: BroadcastedProposalWatcherConfig;
  private lastScannedSlot: SlotNumber | undefined;

  constructor(
    private readonly p2pClient: P2PProposalsForSlotSource,
    private readonly l2BlockSource: Pick<L2BlockSource, 'getSyncedL2SlotNumber'>,
    private readonly epochCache: Pick<EpochCacheInterface, 'getSlotNow' | 'getL1Constants'>,
    config: BroadcastedProposalWatcherConfig,
    scanSlotLookback = DEFAULT_SCAN_SLOT_LOOKBACK,
  ) {
    super();
    const constants = epochCache.getL1Constants();
    this.config = pick(config, ...BroadcastedProposalWatcherConfigKeys);
    this.scanSlotLookback = Math.max(1, scanSlotLookback);

    const intervalMs = Math.max(1000, (constants.ethereumSlotDuration * 1000) / 4);
    this.runningPromise = new RunningPromise(() => this.scan(), this.log, intervalMs);
    this.log.info('BroadcastedProposalWatcher initialized', {
      scanSlotLookback: this.scanSlotLookback,
    });
  }

  public updateConfig(config: Partial<BroadcastedProposalWatcherConfig>): void {
    this.config = merge(this.config, pick(config, ...BroadcastedProposalWatcherConfigKeys));
    this.log.verbose('BroadcastedProposalWatcher config updated', this.config);
  }

  public start(): Promise<void> {
    this.runningPromise.start();
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    return this.runningPromise.stop();
  }

  /**
   * Scans newly closed slots, plus a small lookback for late-arriving proposals. Anchors
   * `currentSlot` at the archiver's last synced L2 slot.
   */
  public async scan(): Promise<void> {
    const currentSlot = (await this.l2BlockSource.getSyncedL2SlotNumber()) ?? this.epochCache.getSlotNow();
    if (currentSlot <= SlotNumber(SCAN_SLOT_LAG)) {
      return;
    }

    const newestSlotToConsider = SlotNumber(currentSlot - 1 - SCAN_SLOT_LAG);
    const oldestLookbackSlot = SlotNumber(Math.max(0, newestSlotToConsider - this.scanSlotLookback + 1));
    const oldestUnscannedSlot =
      this.lastScannedSlot === undefined ? oldestLookbackSlot : SlotNumber(this.lastScannedSlot + 1);
    // Never go below a slot whose emitted offenses were already pruned, so an archiver anchor that moves back does not
    // re-emit them.
    const oldestSlot = SlotNumber(
      Math.max(Math.min(oldestLookbackSlot, oldestUnscannedSlot), this.emittedOffensesPrunedBefore ?? 0),
    );
    this.pruneEmittedOffensesBefore(oldestSlot);
    for (let slot = oldestSlot; slot <= newestSlotToConsider; slot++) {
      await this.scanSlot(SlotNumber(slot));
    }
    this.lastScannedSlot = newestSlotToConsider;
  }

  /** Scans a single slot. Public for tests. */
  public async scanSlot(slot: SlotNumber): Promise<void> {
    const proposals = await this.p2pClient.getProposalsForSlot(slot);
    const slashArgs = this.getSlashArgsForProposals(slot, proposals).filter(args => this.markAsNewOffense(args));
    if (slashArgs.length === 0) {
      return;
    }

    this.log.info(`Detected broadcasted proposal offense`, {
      slot,
      offenses: slashArgs.map(args => ({
        validator: args.validator.toString(),
        amount: args.amount,
        offenseType: getOffenseTypeName(args.offenseType),
        epochOrSlot: args.epochOrSlot,
      })),
    });
    this.emit(WANT_TO_SLASH_EVENT, slashArgs);
  }

  private getSlashArgsForProposals(slot: SlotNumber, proposals: ProposalsForSlot): WantToSlashArgs[] {
    const { blockProposals, checkpointProposals } = proposals;
    const truncators = this.findTruncatedCheckpointSigners(blockProposals, checkpointProposals);
    const equivocators = this.findEquivocators(blockProposals, checkpointProposals);
    return [
      ...[...truncators.values()].map(validator => ({
        validator,
        amount: this.config.slashBroadcastedInvalidCheckpointProposalPenalty,
        offenseType: OffenseType.BROADCASTED_INVALID_CHECKPOINT_PROPOSAL,
        epochOrSlot: BigInt(slot),
      })),
      ...[...equivocators.values()].map(validator => ({
        validator,
        amount: this.config.slashDuplicateProposalPenalty,
        offenseType: OffenseType.DUPLICATE_PROPOSAL,
        epochOrSlot: BigInt(slot),
      })),
    ];
  }

  /**
   * Returns the signers that signed two or more distinct payloads at one position: the same block index, or the
   * slot's checkpoint. A signer that equivocates at several positions is returned once.
   */
  private findEquivocators(
    blockProposals: BlockProposal[],
    checkpointProposals: CheckpointProposalCore[],
  ): Map<string, EthAddress> {
    const groups = new Map<string, { signer: EthAddress; payloadHashes: Set<string> }>();
    const track = (signer: EthAddress | undefined, position: string, payloadHash: string) => {
      if (!signer) {
        return;
      }
      const groupKey = `${signer.toString()}-${position}`;
      const group = groups.get(groupKey) ?? { signer, payloadHashes: new Set<string>() };
      group.payloadHashes.add(payloadHash);
      groups.set(groupKey, group);
    };

    for (const proposal of blockProposals) {
      track(proposal.getSender(), `block-${proposal.indexWithinCheckpoint}`, proposal.getPayloadHash().toString());
    }
    for (const checkpoint of checkpointProposals) {
      track(checkpoint.getSender(), 'checkpoint', checkpoint.getPayloadHash().toString());
    }

    const equivocators = new Map<string, EthAddress>();
    for (const { signer, payloadHashes } of groups.values()) {
      if (payloadHashes.size > 1) {
        equivocators.set(signer.toString(), signer);
      }
    }
    return equivocators;
  }

  private findTruncatedCheckpointSigners(
    blockProposals: BlockProposal[],
    checkpointProposals: CheckpointProposalCore[],
  ) {
    const blocksBySigner = this.getSignedBlocksBySigner(blockProposals);
    const offenders = new Map<string, EthAddress>();

    for (const checkpoint of checkpointProposals) {
      const checkpointSigner = checkpoint.getSender();
      if (!checkpointSigner) {
        continue;
      }

      const signerKey = checkpointSigner.toString();
      const signerBlocks = blocksBySigner.get(signerKey) ?? [];
      const terminalBlocks = signerBlocks.filter(
        ({ proposal }) => proposal.slotNumber === checkpoint.slotNumber && proposal.archive.equals(checkpoint.archive),
      );
      if (terminalBlocks.length === 0) {
        continue;
      }

      const hasTruncatedHigherBlock = terminalBlocks.some(terminalBlock =>
        signerBlocks.some(
          ({ proposal }) =>
            proposal.slotNumber === checkpoint.slotNumber &&
            proposal.indexWithinCheckpoint > terminalBlock.proposal.indexWithinCheckpoint,
        ),
      );
      if (hasTruncatedHigherBlock) {
        offenders.set(signerKey, checkpointSigner);
      }
    }

    return offenders;
  }

  private getSignedBlocksBySigner(blockProposals: BlockProposal[]): Map<string, SignedBlockProposal[]> {
    const blocksBySigner = new Map<string, SignedBlockProposal[]>();
    for (const proposal of blockProposals) {
      const signer = proposal.getSender();
      if (!signer) {
        continue;
      }
      const signerKey = signer.toString();
      const signerBlocks = blocksBySigner.get(signerKey) ?? [];
      signerBlocks.push({ proposal, signer });
      blocksBySigner.set(signerKey, signerBlocks);
    }
    return blocksBySigner;
  }

  private markAsNewOffense(args: WantToSlashArgs): boolean {
    const slot = SlotNumber(Number(args.epochOrSlot));
    const key = `${args.validator.toString()}-${args.offenseType}`;
    const emitted = this.emittedOffensesBySlot.get(slot) ?? new Set<string>();
    if (emitted.has(key)) {
      return false;
    }
    emitted.add(key);
    this.emittedOffensesBySlot.set(slot, emitted);
    return true;
  }

  private pruneEmittedOffensesBefore(oldestSlot: SlotNumber): void {
    this.emittedOffensesPrunedBefore = oldestSlot;
    for (const slot of this.emittedOffensesBySlot.keys()) {
      if (slot < oldestSlot) {
        this.emittedOffensesBySlot.delete(slot);
      }
    }
  }
}
