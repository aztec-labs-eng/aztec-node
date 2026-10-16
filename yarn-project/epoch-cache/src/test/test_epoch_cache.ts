import { EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { L1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import {
  getEpochAtSlot,
  getSlotAtTimestamp,
  getTimestampForSlot,
  getTimestampRangeForEpoch,
} from '@aztec-labs/stdlib/epoch-helpers';

import {
  type CommitteeMembershipLookup,
  type EscapeHatchLookup,
  type KnownCommitteeLookup,
  type ProposerLookup,
  toCommitteeLookup,
  withoutMembers,
} from '../committee_lookup.js';
import {
  type EpochAndSlot,
  type EpochCacheInterface,
  PROPOSER_PIPELINING_SLOT_OFFSET,
  type SlotTag,
} from '../epoch_cache.js';

/** Default L1 constants for testing. */
const DEFAULT_L1_CONSTANTS: L1RollupConstants = {
  l1StartBlock: 0n,
  l1GenesisTime: 0n,
  slotDuration: 24,
  epochDuration: 16,
  ethereumSlotDuration: 12,
  proofSubmissionEpochs: 2,
  targetCommitteeSize: 48,
  rollupManaLimit: Number.MAX_SAFE_INTEGER,
};

/**
 * A test implementation of EpochCacheInterface that allows manual configuration
 * of committee, proposer, slot, and escape hatch state for use in tests.
 *
 * Unlike the real EpochCache, this class doesn't require any RPC connections
 * or mock setup. Simply use the setter methods to configure the test state.
 */
export class TestEpochCache implements EpochCacheInterface {
  private committee: EthAddress[] = [];
  private proposerAddress: EthAddress | undefined;
  private currentSlot: SlotNumber = SlotNumber(0);
  private escapeHatchOpen: boolean = false;
  private seed: bigint = 0n;
  private registeredValidators: EthAddress[] = [];
  private l1Constants: L1RollupConstants;
  private lagInEpochsForValidatorSet = 2;

  constructor(l1Constants: Partial<L1RollupConstants> = {}) {
    this.l1Constants = { ...DEFAULT_L1_CONSTANTS, ...l1Constants };
  }

  setLagInEpochsForValidatorSet(lag: number): this {
    this.lagInEpochsForValidatorSet = lag;
    return this;
  }

  /**
   * Sets the committee members. Used in validation and attestation flows.
   * @param committee - Array of committee member addresses.
   */
  setCommittee(committee: EthAddress[]): this {
    this.committee = committee;
    return this;
  }

  /**
   * Sets the proposer address returned by lookupProposer.
   * @param proposer - The address of the current proposer.
   */
  setProposer(proposer: EthAddress | undefined): this {
    this.proposerAddress = proposer;
    return this;
  }

  /**
   * Sets the current slot number.
   * @param slot - The slot number to set.
   */
  setCurrentSlot(slot: SlotNumber): this {
    this.currentSlot = slot;
    return this;
  }

  /**
   * Sets whether the escape hatch is open.
   * @param open - True if escape hatch should be open.
   */
  setEscapeHatchOpen(open: boolean): this {
    this.escapeHatchOpen = open;
    return this;
  }

  /**
   * Sets the randomness seed used for proposer selection.
   * @param seed - The seed value.
   */
  setSeed(seed: bigint): this {
    this.seed = seed;
    return this;
  }

  /**
   * Sets the list of registered validators (all validators, not just committee).
   * @param validators - Array of validator addresses.
   */
  setRegisteredValidators(validators: EthAddress[]): this {
    this.registeredValidators = validators;
    return this;
  }

  /**
   * Sets the L1 constants used for epoch/slot calculations.
   * @param constants - Partial constants to override defaults.
   */
  setL1Constants(constants: Partial<L1RollupConstants>): this {
    this.l1Constants = { ...this.l1Constants, ...constants };
    return this;
  }

  getL1Constants(): L1RollupConstants {
    return this.l1Constants;
  }

  getLagInEpochsForValidatorSet(): number {
    return this.lagInEpochsForValidatorSet;
  }

  /** An empty committee is `open`, as the real cache reports a target committee size of zero. */
  getCommittee(_slot?: SlotTag): Promise<KnownCommitteeLookup> {
    return Promise.resolve(this.getCommitteeLookup());
  }

  private getCommitteeLookup(): KnownCommitteeLookup {
    const epoch = getEpochAtSlot(this.currentSlot, this.l1Constants);
    return toCommitteeLookup(this.committee, { epoch, seed: this.seed, isEscapeHatchOpen: this.escapeHatchOpen });
  }

  getSlotNow(): SlotNumber {
    return this.currentSlot;
  }

  getTargetSlot(): SlotNumber {
    return SlotNumber(this.currentSlot + PROPOSER_PIPELINING_SLOT_OFFSET);
  }

  getEpochNow(): EpochNumber {
    return getEpochAtSlot(this.currentSlot, this.l1Constants);
  }

  getTargetEpoch(): EpochNumber {
    return getEpochAtSlot(this.getTargetSlot(), this.l1Constants);
  }

  getEpochAndSlotNow(): EpochAndSlot & { nowMs: bigint } {
    // Model "now" as the start of the current slot (mirroring the real EpochCache, which derives nowMs
    // from the wall clock). Using the slot start rather than the epoch start keeps nowMs consistent with
    // currentSlot, which the pipelining receive-window check (clock_tolerance) relies on.
    const epochNow = getEpochAtSlot(this.currentSlot, this.l1Constants);
    const ts = getTimestampForSlot(this.currentSlot, this.l1Constants);
    return {
      epoch: epochNow,
      slot: this.currentSlot,
      ts,
      nowMs: ts * 1000n,
    };
  }

  getEpochAndSlotInNextL1Slot(): EpochAndSlot & { nowSeconds: bigint } {
    const nowTs = getTimestampRangeForEpoch(getEpochAtSlot(this.currentSlot, this.l1Constants), this.l1Constants)[0];
    const nextSlotTs = nowTs + BigInt(this.l1Constants.ethereumSlotDuration);
    const nextSlot = getSlotAtTimestamp(nextSlotTs, this.l1Constants);
    const epochNow = getEpochAtSlot(nextSlot, this.l1Constants);
    const ts = getTimestampRangeForEpoch(epochNow, this.l1Constants)[0];
    return {
      epoch: epochNow,
      slot: nextSlot,
      ts,
      nowSeconds: nowTs,
    };
  }

  getTargetEpochAndSlotInNextL1Slot(): EpochAndSlot & { nowSeconds: bigint } {
    const result = this.getEpochAndSlotInNextL1Slot();
    const offset = PROPOSER_PIPELINING_SLOT_OFFSET;
    const targetSlot = SlotNumber(result.slot + offset);
    return { ...result, slot: targetSlot, epoch: getEpochAtSlot(targetSlot, this.l1Constants) };
  }

  getProposerIndexEncoding(epoch: EpochNumber, slot: SlotNumber, seed: bigint): `0x${string}` {
    // Simple encoding for testing purposes
    return `0x${epoch.toString(16).padStart(64, '0')}${slot.toString(16).padStart(64, '0')}${seed.toString(16).padStart(64, '0')}`;
  }

  computeProposerIndex(slot: SlotNumber, _epoch: EpochNumber, _seed: bigint, size: bigint): bigint {
    if (size === 0n) {
      return 0n;
    }
    return BigInt(slot) % size;
  }

  getCurrentAndNextSlot(): { currentSlot: SlotNumber; nextSlot: SlotNumber } {
    const currentSlot = this.getSlotNow();
    const next = this.getEpochAndSlotInNextL1Slot();

    return {
      currentSlot,
      nextSlot: next.slot,
    };
  }

  getTargetAndNextSlot(): { targetSlot: SlotNumber; nextSlot: SlotNumber } {
    const targetSlot = this.getTargetSlot();
    const next = this.getTargetEpochAndSlotInNextL1Slot();

    return {
      targetSlot,
      nextSlot: next.slot,
    };
  }

  /** An unset proposer is an `open` committee, independently of the committee set with {@link setCommittee}. */
  lookupProposer(_slot: SlotNumber): Promise<ProposerLookup> {
    return Promise.resolve(
      this.proposerAddress === undefined ? { state: 'open' } : { state: 'members', proposer: this.proposerAddress },
    );
  }

  getRegisteredValidators(): Promise<EthAddress[]> {
    return Promise.resolve(this.registeredValidators);
  }

  lookupMembership(_slot: SlotTag, validator: EthAddress): Promise<CommitteeMembershipLookup<boolean>> {
    const lookup = this.getCommitteeLookup();
    return Promise.resolve(
      lookup.state === 'members'
        ? { state: 'members', inCommittee: lookup.committee.some(v => v.equals(validator)) }
        : withoutMembers(lookup),
    );
  }

  filterInCommittee(_slot: SlotTag, validators: EthAddress[]): Promise<CommitteeMembershipLookup<EthAddress[]>> {
    const lookup = this.getCommitteeLookup();
    if (lookup.state !== 'members') {
      return Promise.resolve(withoutMembers(lookup));
    }
    const committeeSet = new Set(lookup.committee.map(v => v.toString()));
    return Promise.resolve({ state: 'members', inCommittee: validators.filter(v => committeeSet.has(v.toString())) });
  }

  lookupEscapeHatch(_epoch: EpochNumber): Promise<EscapeHatchLookup> {
    return Promise.resolve({ state: this.getCommitteeLookup().state, isEscapeHatchOpen: this.escapeHatchOpen });
  }

  lookupEscapeHatchAtSlot(_slot?: SlotTag): Promise<EscapeHatchLookup> {
    return Promise.resolve({ state: this.getCommitteeLookup().state, isEscapeHatchOpen: this.escapeHatchOpen });
  }
}
