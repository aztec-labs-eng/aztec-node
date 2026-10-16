import { CommitteeNotStableError } from '@aztec-labs/ethereum/contracts';
import type { EpochNumber } from '@aztec-labs/foundation/branded-types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

/** The epoch's committee cannot be known yet: its sample seed can still change on L1. */
export type UnstableCommittee = {
  state: 'unstable';
  epoch: EpochNumber;
  /** L1 block at which the seed was found not to be fixed yet. */
  l1BlockNumber: bigint;
};

/**
 * Outcome of a committee lookup, with `TMembers` the data derived from a non-empty committee and `TKnown` the data
 * available in every state whose committee is known:
 * - `members`: the epoch has a non-empty committee.
 * - `open`: the target committee size is zero, so anyone may propose and nobody attests.
 * - `none`: L1 has no committee for the epoch, because the validator set is smaller than the target committee size.
 * - `unstable`: see {@link UnstableCommittee}. Never treat it as `open` or `none`: it says nothing about the committee.
 */
export type CommitteeLookupOf<TMembers extends object, TKnown extends object = object> =
  | ({ state: 'members' } & TMembers & TKnown)
  | ({ state: 'open' } & TKnown)
  | ({ state: 'none' } & TKnown)
  | UnstableCommittee;

/** Data an epoch's entry holds whenever its committee is known. */
export type EpochCommitteeInfo = {
  epoch: EpochNumber;
  seed: bigint;
  /** True if the epoch is within an open escape hatch window. */
  isEscapeHatchOpen: boolean;
};

/** An epoch's committee. */
export type CommitteeLookup = CommitteeLookupOf<{ committee: EthAddress[] }, EpochCommitteeInfo>;

/** An epoch's committee once known, i.e. any state but `unstable`. */
export type KnownCommitteeLookup = Exclude<CommitteeLookup, UnstableCommittee>;

/** A slot's proposer, which only a `members` committee has. */
export type ProposerLookup = CommitteeLookupOf<{ proposer: EthAddress }>;

/** Whether an epoch's escape hatch is open, known in every state but `unstable`. */
export type EscapeHatchLookup = CommitteeLookupOf<object, { isEscapeHatchOpen: boolean }>;

/** Which of a set of addresses sit on a `members` committee. */
export type CommitteeMembershipLookup<T> = CommitteeLookupOf<{ inCommittee: T }>;

/**
 * Classifies a committee as `RollupContract.getCommitteeAt` returns it: `undefined` when L1 has no committee, and an
 * empty list when the target committee size is zero.
 */
export function toCommitteeLookup(committee: EthAddress[] | undefined, info: EpochCommitteeInfo): KnownCommitteeLookup {
  if (committee === undefined) {
    return { state: 'none', ...info };
  }
  if (committee.length === 0) {
    return { state: 'open', ...info };
  }
  return { state: 'members', committee, ...info };
}

/** Narrows a committee lookup without members to its state, which is all a lookup derived from it carries. */
export function withoutMembers(
  lookup: Exclude<CommitteeLookup, { state: 'members' }>,
): { state: 'open' } | { state: 'none' } | UnstableCommittee {
  return lookup.state === 'unstable' ? lookup : { state: lookup.state };
}

/**
 * Returns the lookup if its committee is known, and throws {@link CommitteeNotStableError} otherwise. For callers that
 * cannot act without the committee and rely on a thrown error to retry later.
 */
export function requireStableCommittee<T extends { state: string }>(lookup: T | UnstableCommittee): T {
  if (isUnstableCommittee(lookup)) {
    throw new CommitteeNotStableError(BigInt(lookup.epoch), lookup.l1BlockNumber);
  }
  return lookup;
}

function isUnstableCommittee(lookup: { state: string }): lookup is UnstableCommittee {
  return lookup.state === 'unstable';
}
