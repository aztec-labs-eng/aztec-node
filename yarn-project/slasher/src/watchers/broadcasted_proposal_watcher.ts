import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { SlotNumber } from '@aztec-labs/foundation/branded-types';
import { areArraysEqual, merge, pick } from '@aztec-labs/foundation/collection';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';
import type { L1ProposerSource, L2Block, L2BlockSource } from '@aztec-labs/stdlib/block';
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

function emittedOffenseKey(validator: EthAddress, offenseType: OffenseType): string {
  return `${validator.toString()}-${offenseType}`;
}

/** Whether a gossiped block proposal carries the same archive root and ordered tx hashes as a block published on L1. */
function matchesL1Block(proposal: BlockProposal, l1Block: L2Block): boolean {
  return (
    proposal.archive.equals(l1Block.archive.root) &&
    areArraysEqual(
      proposal.txHashes,
      l1Block.body.txEffects.map(effect => effect.txHash),
      (a, b) => a.equals(b),
    )
  );
}

/**
 * Detects offenses in retained signed P2P proposals once their slot has closed: truncated checkpoint proposals, and
 * duplicate proposals, where one signer signed two different payloads for the same block index or for the slot's
 * checkpoint. Offenses are attributed to the signer recovered from each proposal, so payloads from different signers
 * at the same position are never counted against each other. A block proposal that differs from the block at the same
 * index in the slot's L1 checkpoint is also a duplicate proposal, attributed only to the key the rollup required to
 * sign that checkpoint.
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
    private readonly l2BlockSource: Pick<L2BlockSource, 'getSyncedL2SlotNumber' | 'getCheckpoint'>,
    private readonly l1ProposerSource: L1ProposerSource,
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
    const slashArgs = (await this.getSlashArgsForProposals(slot, proposals)).filter(args =>
      this.markAsNewOffense(args),
    );
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

  private async getSlashArgsForProposals(slot: SlotNumber, proposals: ProposalsForSlot): Promise<WantToSlashArgs[]> {
    const { blockProposals, checkpointProposals } = proposals;
    const truncators = this.findTruncatedCheckpointSigners(blockProposals, checkpointProposals);
    const equivocators = this.findEquivocators(blockProposals, checkpointProposals);
    const l1Equivocator = await this.findL1Equivocator(slot, blockProposals);
    if (l1Equivocator) {
      equivocators.set(l1Equivocator.toString(), l1Equivocator);
    }
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

  /**
   * Returns the slot's L1 proposer if it gossiped a block proposal that differs from the block at the same index in the
   * checkpoint L1 accepted for the slot. A gossiped index beyond the L1 checkpoint's blocks is truncation rather than a
   * second payload at one position, and is left out. So is an L1 block from another slot, which the archiver can return
   * when a prune and re-add of the checkpoint land between its reads.
   */
  private async findL1Equivocator(slot: SlotNumber, blockProposals: BlockProposal[]): Promise<EthAddress | undefined> {
    // A signer already reported for the slot needs no L1 read or lookup, which would otherwise repeat on every scan.
    const unreported = blockProposals.filter(proposal => {
      const signer = proposal.getSender();
      return signer !== undefined && !this.hasEmittedOffense(slot, signer, OffenseType.DUPLICATE_PROPOSAL);
    });
    if (unreported.length === 0) {
      return undefined;
    }
    const l1Blocks = await this.tryGetL1BlocksForSlot(slot);
    if (!l1Blocks) {
      return undefined;
    }
    const diverging = unreported.filter(proposal => {
      const l1Block = l1Blocks[proposal.indexWithinCheckpoint];
      return l1Block !== undefined && l1Block.slot === slot && !matchesL1Block(proposal, l1Block);
    });
    if (diverging.length === 0) {
      return undefined;
    }

    // An uncached L1 call. It repeats on every scan only while a diverging proposal stays unreported, which happens with
    // an empty committee: in that dev setup anyone may propose, so the blocks of sequencers that lost the slot differ from
    // L1 and are never attributed.
    const l1Proposer = await this.tryGetL1ProposerForSlot(slot);
    if (!l1Proposer || !diverging.some(proposal => proposal.getSender()?.equals(l1Proposer))) {
      return undefined;
    }
    return l1Proposer;
  }

  /**
   * Returns the blocks of the slot's L1 checkpoint, or undefined when there is none or it cannot be read. A failed read
   * skips only the L1 comparison, so the slot's gossip-only offenses and the later slots in the scan are still reported.
   */
  private async tryGetL1BlocksForSlot(slot: SlotNumber): Promise<L2Block[] | undefined> {
    try {
      return (await this.l2BlockSource.getCheckpoint({ slot }))?.checkpoint.blocks;
    } catch (err) {
      this.log.warn(`Failed to read the L1 checkpoint for slot ${slot}`, { slot, err });
      return undefined;
    }
  }

  /** Returns undefined when the lookup fails, leaving the slot to be compared again on a later scan. */
  private async tryGetL1ProposerForSlot(slot: SlotNumber): Promise<EthAddress | undefined> {
    try {
      return await this.l1ProposerSource.getL1ProposerForSlot(slot);
    } catch (err) {
      this.log.warn(`Failed to get the L1 proposer for slot ${slot}`, { slot, err });
      return undefined;
    }
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

  private hasEmittedOffense(slot: SlotNumber, validator: EthAddress, offenseType: OffenseType): boolean {
    return this.emittedOffensesBySlot.get(slot)?.has(emittedOffenseKey(validator, offenseType)) ?? false;
  }

  private markAsNewOffense(args: WantToSlashArgs): boolean {
    const slot = SlotNumber(Number(args.epochOrSlot));
    if (this.hasEmittedOffense(slot, args.validator, args.offenseType)) {
      return false;
    }
    const emitted = this.emittedOffensesBySlot.get(slot) ?? new Set<string>();
    emitted.add(emittedOffenseKey(args.validator, args.offenseType));
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
