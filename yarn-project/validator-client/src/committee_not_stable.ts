import type { UnstableCommittee } from '@aztec-labs/epoch-cache';
import type { SlotNumber } from '@aztec-labs/foundation/branded-types';
import type { Logger } from '@aztec-labs/foundation/log';

/**
 * Logs a proposal dropped because its slot's committee is not stable on L1. p2p only delivers proposals whose
 * committee it resolved, so this takes an L1 reorg that removes the randao the seed was fixed by.
 */
export function warnCommitteeNotStable(
  log: Logger,
  lookup: UnstableCommittee,
  slotNumber: SlotNumber,
  subject: string,
): void {
  log.warn(`Not handling ${subject} for slot ${slotNumber}: its committee is not stable on L1`, {
    slotNumber,
    epoch: lookup.epoch,
    l1BlockNumber: lookup.l1BlockNumber,
  });
}
