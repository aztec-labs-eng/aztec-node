import { MAX_NOTE_HASHES_PER_TX, MAX_TX_LIFETIME } from '@aztec-labs/constants';
import { PaddedSideEffectAmounts } from '@aztec-labs/stdlib/kernel';

import type {
  ExpirationAndPaddingRequest,
  ResolveExpirationAndPadding,
  SideEffectCounts,
  TxSideEffectCounts,
} from '../../hooks/resolve_expiration_and_padding.js';
import { applyExpirationAndPaddingHook } from './expiration_and_padding.js';
import { roundDownTxExpirationTimestamp } from './round_down_tx_expiration_timestamp.js';

describe('applyExpirationAndPaddingHook', () => {
  const ANCHOR_BLOCK_TIMESTAMP = 1_000_000n;
  const MAX_EXPIRATION_TIMESTAMP = ANCHOR_BLOCK_TIMESTAMP + BigInt(MAX_TX_LIFETIME) - 1n;

  // The side effects each tx publishes before padding.
  const ORIGINAL_PRIVATE_ONLY: SideEffectCounts = { noteHashes: 2, nullifiers: 1, privateLogs: 2 };
  const ORIGINAL_NON_REVERTIBLE: SideEffectCounts = { noteHashes: 1, nullifiers: 1, privateLogs: 0 };
  const ORIGINAL_REVERTIBLE: SideEffectCounts = { noteHashes: 2, nullifiers: 3, privateLogs: 1 };

  const PRIVATE_ONLY_TX: TxSideEffectCounts = { isPrivateOnlyTx: true, ...ORIGINAL_PRIVATE_ONLY };
  const TX_WITH_PUBLIC_CALLS: TxSideEffectCounts = {
    isPrivateOnlyTx: false,
    nonRevertible: ORIGINAL_NON_REVERTIBLE,
    revertible: ORIGINAL_REVERTIBLE,
  };

  const makeRequest = (minSideEffects: TxSideEffectCounts): ExpirationAndPaddingRequest => ({
    anchorBlockTimestamp: ANCHOR_BLOCK_TIMESTAMP,
    maxExpirationTimestamp: MAX_EXPIRATION_TIMESTAMP,
    minSideEffects,
  });

  /** A hook padding up to `sideEffects` and keeping the default expiry. */
  const padTo =
    (sideEffects: TxSideEffectCounts): ResolveExpirationAndPadding =>
    request =>
      Promise.resolve({ expirationTimestamp: roundDownTxExpirationTimestamp(request), sideEffects });

  it('rounds the expiry down and adds no padding when there is no hook', async () => {
    const request = makeRequest(TX_WITH_PUBLIC_CALLS);

    const result = await applyExpirationAndPaddingHook(undefined, request);

    expect(result).toEqual({
      expirationTimestampUpperBound: roundDownTxExpirationTimestamp(request),
      paddedSideEffectAmounts: PaddedSideEffectAmounts.empty(),
    });
  });

  it('publishes the expiry the hook returns', async () => {
    const hookExpirationTimestamp = ANCHOR_BLOCK_TIMESTAMP + 1234n;
    const hook: ResolveExpirationAndPadding = request =>
      Promise.resolve({ expirationTimestamp: hookExpirationTimestamp, sideEffects: request.minSideEffects });

    const result = await applyExpirationAndPaddingHook(hook, makeRequest(TX_WITH_PUBLIC_CALLS));

    expect(result.expirationTimestampUpperBound).toBe(hookExpirationTimestamp);
  });

  it('pads each phase of a tx with public calls up to the hook counts', async () => {
    const TARGET_NON_REVERTIBLE: SideEffectCounts = { noteHashes: 4, nullifiers: 1, privateLogs: 2 };
    const TARGET_REVERTIBLE: SideEffectCounts = { noteHashes: 2, nullifiers: 8, privateLogs: 3 };
    const hook = padTo({ isPrivateOnlyTx: false, nonRevertible: TARGET_NON_REVERTIBLE, revertible: TARGET_REVERTIBLE });

    const result = await applyExpirationAndPaddingHook(hook, makeRequest(TX_WITH_PUBLIC_CALLS));

    expect(result.paddedSideEffectAmounts).toEqual(
      new PaddedSideEffectAmounts(
        TARGET_NON_REVERTIBLE.noteHashes - ORIGINAL_NON_REVERTIBLE.noteHashes,
        TARGET_REVERTIBLE.noteHashes - ORIGINAL_REVERTIBLE.noteHashes,
        TARGET_NON_REVERTIBLE.nullifiers - ORIGINAL_NON_REVERTIBLE.nullifiers,
        TARGET_REVERTIBLE.nullifiers - ORIGINAL_REVERTIBLE.nullifiers,
        TARGET_NON_REVERTIBLE.privateLogs - ORIGINAL_NON_REVERTIBLE.privateLogs,
        TARGET_REVERTIBLE.privateLogs - ORIGINAL_REVERTIBLE.privateLogs,
      ),
    );
  });

  it('counts the padding of a private-only tx as non-revertible', async () => {
    const TARGET_PRIVATE_ONLY: SideEffectCounts = { noteHashes: 8, nullifiers: 4, privateLogs: 2 };
    const hook = padTo({ isPrivateOnlyTx: true, ...TARGET_PRIVATE_ONLY });

    const result = await applyExpirationAndPaddingHook(hook, makeRequest(PRIVATE_ONLY_TX));

    expect(result.paddedSideEffectAmounts).toEqual(
      new PaddedSideEffectAmounts(
        TARGET_PRIVATE_ONLY.noteHashes - ORIGINAL_PRIVATE_ONLY.noteHashes,
        0,
        TARGET_PRIVATE_ONLY.nullifiers - ORIGINAL_PRIVATE_ONLY.nullifiers,
        0,
        TARGET_PRIVATE_ONLY.privateLogs - ORIGINAL_PRIVATE_ONLY.privateLogs,
        0,
      ),
    );
  });

  it('pads up to exactly the per-tx maximum', async () => {
    const hook = padTo({ ...PRIVATE_ONLY_TX, noteHashes: MAX_NOTE_HASHES_PER_TX });

    const result = await applyExpirationAndPaddingHook(hook, makeRequest(PRIVATE_ONLY_TX));

    expect(result.paddedSideEffectAmounts.nonRevertibleNoteHashes).toBe(
      MAX_NOTE_HASHES_PER_TX - ORIGINAL_PRIVATE_ONLY.noteHashes,
    );
  });

  it('checks the result against the original request when the hook changes the request it received', async () => {
    const TARGET_NOTE_HASHES = 4;
    const hook: ResolveExpirationAndPadding = request => {
      if (request.minSideEffects.isPrivateOnlyTx) {
        request.minSideEffects.noteHashes = TARGET_NOTE_HASHES;
      }
      return Promise.resolve({
        expirationTimestamp: roundDownTxExpirationTimestamp(request),
        sideEffects: request.minSideEffects,
      });
    };

    const result = await applyExpirationAndPaddingHook(hook, makeRequest(PRIVATE_ONLY_TX));

    expect(result.paddedSideEffectAmounts.nonRevertibleNoteHashes).toBe(
      TARGET_NOTE_HASHES - ORIGINAL_PRIVATE_ONLY.noteHashes,
    );
  });

  it('throws when the hook pads past the per-tx maximum', async () => {
    const hook = padTo({ ...PRIVATE_ONLY_TX, noteHashes: MAX_NOTE_HASHES_PER_TX + 1 });

    await expect(applyExpirationAndPaddingHook(hook, makeRequest(PRIVATE_ONLY_TX))).rejects.toThrow(
      `returned ${MAX_NOTE_HASHES_PER_TX + 1} noteHashes, more than the per-tx maximum of ${MAX_NOTE_HASHES_PER_TX}`,
    );
  });

  it('throws when the phases of a tx with public calls together exceed the per-tx maximum', async () => {
    const hook = padTo({
      isPrivateOnlyTx: false,
      nonRevertible: { ...ORIGINAL_NON_REVERTIBLE, noteHashes: MAX_NOTE_HASHES_PER_TX / 2 },
      revertible: { ...ORIGINAL_REVERTIBLE, noteHashes: MAX_NOTE_HASHES_PER_TX / 2 + 1 },
    });

    await expect(applyExpirationAndPaddingHook(hook, makeRequest(TX_WITH_PUBLIC_CALLS))).rejects.toThrow(
      `returned ${MAX_NOTE_HASHES_PER_TX + 1} noteHashes, more than the per-tx maximum`,
    );
  });

  it('throws when the hook returns fewer side effects than the tx has', async () => {
    const hook = padTo({
      ...TX_WITH_PUBLIC_CALLS,
      nonRevertible: { ...ORIGINAL_NON_REVERTIBLE, nullifiers: ORIGINAL_NON_REVERTIBLE.nullifiers - 1 },
    });

    await expect(applyExpirationAndPaddingHook(hook, makeRequest(TX_WITH_PUBLIC_CALLS))).rejects.toThrow(
      `returned ${ORIGINAL_NON_REVERTIBLE.nullifiers - 1} nonRevertible nullifiers, fewer than the tx's ${ORIGINAL_NON_REVERTIBLE.nullifiers}`,
    );
  });

  it.each([2.5, NaN])('throws when the hook returns a count of %p', async count => {
    const hook = padTo({ ...PRIVATE_ONLY_TX, noteHashes: count });

    await expect(applyExpirationAndPaddingHook(hook, makeRequest(PRIVATE_ONLY_TX))).rejects.toThrow(
      `returned ${count} nonRevertible noteHashes, not a whole number`,
    );
  });

  it('throws when the hook returns side effects for the other kind of tx', async () => {
    const hook = padTo(TX_WITH_PUBLIC_CALLS);

    await expect(applyExpirationAndPaddingHook(hook, makeRequest(PRIVATE_ONLY_TX))).rejects.toThrow(
      'returned side effects with isPrivateOnlyTx false for a tx with isPrivateOnlyTx true',
    );
  });

  it('throws when the hook returns an expiry later than the maximum', async () => {
    const hook: ResolveExpirationAndPadding = request =>
      Promise.resolve({
        expirationTimestamp: request.maxExpirationTimestamp + 1n,
        sideEffects: request.minSideEffects,
      });

    await expect(applyExpirationAndPaddingHook(hook, makeRequest(PRIVATE_ONLY_TX))).rejects.toThrow(
      `returned expiration timestamp ${MAX_EXPIRATION_TIMESTAMP + 1n}, later than the tx's maximum of ${MAX_EXPIRATION_TIMESTAMP}`,
    );
  });

  it('throws when the hook returns an expiry no later than the anchor block', async () => {
    const hook: ResolveExpirationAndPadding = request =>
      Promise.resolve({ expirationTimestamp: request.anchorBlockTimestamp, sideEffects: request.minSideEffects });

    await expect(applyExpirationAndPaddingHook(hook, makeRequest(PRIVATE_ONLY_TX))).rejects.toThrow(
      `not later than the anchor block timestamp ${ANCHOR_BLOCK_TIMESTAMP}`,
    );
  });

  it('accepts an expiry one second after the anchor block', async () => {
    const hook: ResolveExpirationAndPadding = request =>
      Promise.resolve({ expirationTimestamp: request.anchorBlockTimestamp + 1n, sideEffects: request.minSideEffects });

    const result = await applyExpirationAndPaddingHook(hook, makeRequest(PRIVATE_ONLY_TX));

    expect(result.expirationTimestampUpperBound).toBe(ANCHOR_BLOCK_TIMESTAMP + 1n);
  });
});
