import { MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX, MAX_PRIVATE_LOGS_PER_TX } from '@aztec-labs/constants';
import { times } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { PaddedSideEffectAmounts } from '@aztec-labs/stdlib/kernel';
import { PrivateLog } from '@aztec-labs/stdlib/logs';
import type { UInt64 } from '@aztec-labs/stdlib/types';

import type {
  ExpirationAndPaddingRequest,
  ResolveExpirationAndPadding,
  SideEffectCounts,
  TxSideEffectCounts,
} from '../../hooks/resolve_expiration_and_padding.js';
import { roundDownTxExpirationTimestamp } from './round_down_tx_expiration_timestamp.js';

const SIDE_EFFECT_KINDS = ['noteHashes', 'nullifiers', 'privateLogs'] as const;

const MAX_SIDE_EFFECTS_PER_TX: SideEffectCounts = {
  noteHashes: MAX_NOTE_HASHES_PER_TX,
  nullifiers: MAX_NULLIFIERS_PER_TX,
  privateLogs: MAX_PRIVATE_LOGS_PER_TX,
};

const NO_SIDE_EFFECTS: SideEffectCounts = { noteHashes: 0, nullifiers: 0, privateLogs: 0 };

/** The private log field where an aztec-nr message carries its ephemeral public key's x-coordinate, after the tag. */
const EPHEMERAL_PUBLIC_KEY_X_FIELD_INDEX = 1;

/**
 * Resolves the expiry a tx publishes and the padding it adds, through the wallet's hook or PXE's default when the hook
 * is absent, as the inputs the final kernel takes. Throws if the hook chooses an expiry or padding the kernels cannot
 * publish.
 */
export async function applyExpirationAndPaddingHook(
  hook: ResolveExpirationAndPadding | undefined,
  request: ExpirationAndPaddingRequest,
): Promise<{ expirationTimestampUpperBound: UInt64; paddedSideEffectAmounts: PaddedSideEffectAmounts }> {
  if (!hook) {
    return {
      expirationTimestampUpperBound: roundDownTxExpirationTimestamp(request),
      paddedSideEffectAmounts: PaddedSideEffectAmounts.empty(),
    };
  }

  // The hook gets a copy, so that changes it makes to the request cannot move the bounds its result is checked against.
  const { expirationTimestamp, sideEffects } = await hook(structuredClone(request));
  if (expirationTimestamp > request.maxExpirationTimestamp) {
    throw new Error(
      `resolveExpirationAndPadding hook returned expiration timestamp ${expirationTimestamp}, later than the tx's maximum of ${request.maxExpirationTimestamp}. The kernels can only lower it.`,
    );
  }
  if (expirationTimestamp <= request.anchorBlockTimestamp) {
    throw new Error(
      `resolveExpirationAndPadding hook returned expiration timestamp ${expirationTimestamp}, not later than the anchor block timestamp ${request.anchorBlockTimestamp}, so the tx could only be included in a block sharing the anchor block's timestamp.`,
    );
  }

  return {
    expirationTimestampUpperBound: expirationTimestamp,
    paddedSideEffectAmounts: getPaddedSideEffectAmounts(request.minSideEffects, sideEffects),
  };
}

/**
 * Makes random side effects to pad a tx with, by the amounts in `paddedSideEffectAmounts`, shaped so that they cannot
 * be told apart from real ones.
 */
export async function makePadding(paddedSideEffectAmounts: PaddedSideEffectAmounts) {
  const makePhase = async (noteHashes: number, nullifiers: number, privateLogs: number) => ({
    noteHashes: times(noteHashes, () => Fr.random()),
    nullifiers: times(nullifiers, () => Fr.random()),
    privateLogs: await Promise.all(times(privateLogs, makePaddingPrivateLog)),
  });

  return {
    nonRevertible: await makePhase(
      paddedSideEffectAmounts.nonRevertibleNoteHashes,
      paddedSideEffectAmounts.nonRevertibleNullifiers,
      paddedSideEffectAmounts.nonRevertiblePrivateLogs,
    ),
    revertible: await makePhase(
      paddedSideEffectAmounts.revertibleNoteHashes,
      paddedSideEffectAmounts.revertibleNullifiers,
      paddedSideEffectAmounts.revertiblePrivateLogs,
    ),
  };
}

/**
 * A random private log shaped like an aztec-nr message. Its ephemeral public key field holds the x-coordinate of a
 * random curve point, as in a real message: a uniformly random field is not one about half of the time.
 */
async function makePaddingPrivateLog(): Promise<PrivateLog> {
  const log = PrivateLog.random();
  log.fields[EPHEMERAL_PUBLIC_KEY_X_FIELD_INDEX] = (await Point.random()).x;
  return log;
}

/** Returns how many padding items each phase gets: the difference between the padded and the unpadded counts. */
function getPaddedSideEffectAmounts(counts: TxSideEffectCounts, paddedCounts: TxSideEffectCounts) {
  if (counts.isPrivateOnlyTx !== paddedCounts.isPrivateOnlyTx) {
    throw new Error(
      `resolveExpirationAndPadding hook returned side effects with isPrivateOnlyTx ${paddedCounts.isPrivateOnlyTx} for a tx with isPrivateOnlyTx ${counts.isPrivateOnlyTx}.`,
    );
  }

  const unpadded = splitIntoPhases(counts);
  const padded = splitIntoPhases(paddedCounts);
  const amounts = { nonRevertible: { ...NO_SIDE_EFFECTS }, revertible: { ...NO_SIDE_EFFECTS } };
  for (const kind of SIDE_EFFECT_KINDS) {
    for (const phase of ['nonRevertible', 'revertible'] as const) {
      if (!Number.isInteger(padded[phase][kind])) {
        throw new Error(
          `resolveExpirationAndPadding hook returned ${padded[phase][kind]} ${phase} ${kind}, not a whole number.`,
        );
      }
      amounts[phase][kind] = padded[phase][kind] - unpadded[phase][kind];
      if (amounts[phase][kind] < 0) {
        throw new Error(
          `resolveExpirationAndPadding hook returned ${padded[phase][kind]} ${phase} ${kind}, fewer than the tx's ${unpadded[phase][kind]}.`,
        );
      }
    }

    const total = padded.nonRevertible[kind] + padded.revertible[kind];
    if (total > MAX_SIDE_EFFECTS_PER_TX[kind]) {
      throw new Error(
        `resolveExpirationAndPadding hook returned ${total} ${kind}, more than the per-tx maximum of ${MAX_SIDE_EFFECTS_PER_TX[kind]}.`,
      );
    }
  }

  return new PaddedSideEffectAmounts(
    amounts.nonRevertible.noteHashes,
    amounts.revertible.noteHashes,
    amounts.nonRevertible.nullifiers,
    amounts.revertible.nullifiers,
    amounts.nonRevertible.privateLogs,
    amounts.revertible.privateLogs,
  );
}

/** The side effects of a private-only tx persist whenever the tx is included, so they all count as non-revertible. */
function splitIntoPhases(counts: TxSideEffectCounts): {
  nonRevertible: SideEffectCounts;
  revertible: SideEffectCounts;
} {
  return counts.isPrivateOnlyTx ? { nonRevertible: counts, revertible: NO_SIDE_EFFECTS } : counts;
}
