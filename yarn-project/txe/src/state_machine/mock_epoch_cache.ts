import type {
  CommitteeLookup,
  CommitteeMembershipLookup,
  EpochAndSlot,
  EpochCacheInterface,
  EscapeHatchLookup,
  ProposerLookup,
  SlotTag,
} from '@aztec-labs/epoch-cache';
import { EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { EmptyL1RollupConstants, type L1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';

/**
 * Mock implementation of the EpochCacheInterface used to satisfy dependencies of AztecNodeService.
 * Since in TXE we don't validate transactions, mock suffices here.
 */
export class MockEpochCache implements EpochCacheInterface {
  getCommittee(_slot: SlotTag = 'now'): Promise<CommitteeLookup> {
    return Promise.resolve({ state: 'none', seed: 0n, epoch: EpochNumber.ZERO, isEscapeHatchOpen: false });
  }

  getSlotNow(): SlotNumber {
    return SlotNumber(0);
  }

  getTargetSlot(): SlotNumber {
    return SlotNumber(0);
  }

  getEpochNow(): EpochNumber {
    return EpochNumber.ZERO;
  }

  getTargetEpoch(): EpochNumber {
    return EpochNumber.ZERO;
  }

  getEpochAndSlotNow(): EpochAndSlot & { nowMs: bigint } {
    return {
      epoch: EpochNumber.ZERO,
      slot: SlotNumber(0),
      ts: 0n,
      nowMs: 0n,
    };
  }

  getEpochAndSlotInNextL1Slot(): EpochAndSlot & { nowSeconds: bigint } {
    return {
      epoch: EpochNumber.ZERO,
      slot: SlotNumber(0),
      ts: 0n,
      nowSeconds: 0n,
    };
  }

  getTargetEpochAndSlotInNextL1Slot(): EpochAndSlot & { nowSeconds: bigint } {
    return this.getEpochAndSlotInNextL1Slot();
  }

  getProposerIndexEncoding(_epoch: EpochNumber, _slot: SlotNumber, _seed: bigint): `0x${string}` {
    return '0x00';
  }

  computeProposerIndex(_slot: SlotNumber, _epoch: EpochNumber, _seed: bigint, _size: bigint): bigint {
    return 0n;
  }

  getCurrentAndNextSlot(): { currentSlot: SlotNumber; nextSlot: SlotNumber } {
    return {
      currentSlot: SlotNumber(0),
      nextSlot: SlotNumber(0),
    };
  }

  getTargetAndNextSlot(): { targetSlot: SlotNumber; nextSlot: SlotNumber } {
    return {
      targetSlot: SlotNumber(0),
      nextSlot: SlotNumber(0),
    };
  }

  lookupProposer(_slot: SlotNumber): Promise<ProposerLookup> {
    return Promise.resolve({ state: 'none' });
  }

  lookupMembership(_slot: SlotTag, _validator: EthAddress): Promise<CommitteeMembershipLookup<boolean>> {
    return Promise.resolve({ state: 'none' });
  }

  getRegisteredValidators(): Promise<EthAddress[]> {
    return Promise.resolve([]);
  }

  filterInCommittee(_slot: SlotTag, _validators: EthAddress[]): Promise<CommitteeMembershipLookup<EthAddress[]>> {
    return Promise.resolve({ state: 'none' });
  }

  lookupEscapeHatch(_epoch: EpochNumber): Promise<EscapeHatchLookup> {
    return Promise.resolve({ state: 'none', isEscapeHatchOpen: false });
  }

  lookupEscapeHatchAtSlot(_slot: SlotTag): Promise<EscapeHatchLookup> {
    return Promise.resolve({ state: 'none', isEscapeHatchOpen: false });
  }

  getL1Constants(): L1RollupConstants {
    return EmptyL1RollupConstants;
  }

  getLagInEpochsForValidatorSet(): number {
    return 0;
  }
}
