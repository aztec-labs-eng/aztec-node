import { EpochNumber } from '@aztec-labs/foundation/branded-types';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';

import {
  type CommitteeMembershipLookup,
  type EpochCommitteeInfo,
  type EscapeHatchLookup,
  type KnownCommitteeLookup,
  type ProposerLookup,
  type UnstableCommittee,
  toCommitteeLookup,
} from '../committee_lookup.js';

/** Builds a committee lookup from a committee as L1 returns it: `undefined` is `none` and `[]` is `open`. */
export function makeCommitteeLookup({
  committee,
  ...info
}: { committee: EthAddress[] | undefined } & Partial<EpochCommitteeInfo>): KnownCommitteeLookup {
  return toCommitteeLookup(committee, { epoch: EpochNumber.ZERO, seed: 0n, isEscapeHatchOpen: false, ...info });
}

/** Builds a proposer lookup: `undefined` is an `open` committee, as the proposer getter used to report it. */
export function makeProposerLookup(proposer: EthAddress | undefined): ProposerLookup {
  return proposer === undefined ? { state: 'open' } : { state: 'members', proposer };
}

/** Builds a membership lookup for a `members` committee. */
export function makeMembershipLookup<T>(inCommittee: T): CommitteeMembershipLookup<T> {
  return { state: 'members', inCommittee };
}

/** Builds an escape hatch lookup for a `members` committee. */
export function makeEscapeHatchLookup(isEscapeHatchOpen: boolean): EscapeHatchLookup {
  return { state: 'members', isEscapeHatchOpen };
}

/** Builds the lookup for a committee whose seed is not fixed on L1 yet. */
export function makeUnstableCommittee(epoch: EpochNumber = EpochNumber.ZERO, l1BlockNumber = 0n): UnstableCommittee {
  return { state: 'unstable', epoch, l1BlockNumber };
}
