import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BatchCall } from '@aztec-labs/aztec.js/contracts';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { TxExecutionResult, type TxHash } from '@aztec-labs/aztec.js/tx';
import { TestContract } from '@aztec-labs/noir-test-contracts.js/Test';
import { TestLogContract } from '@aztec-labs/noir-test-contracts.js/TestLog';
import {
  type ExpirationAndPadding,
  type ResolveExpirationAndPadding,
  type SideEffectCounts,
  type TxSideEffectCounts,
  roundDownTxExpirationTimestamp,
} from '@aztec-labs/pxe/server';
import { jest } from '@jest/globals';

import { padSideEffectCounts } from '../fixtures/side_effect_padding.js';
import type { TestWallet } from '../test-wallet/test_wallet.js';
import { proveInteraction } from '../test-wallet/utils.js';
import { AutomineTestContext } from './automine_test_context.js';

const TIMEOUT = 300_000;

// Covers the resolveExpirationAndPadding PXE hook.
describe('automine/resolve_expiration_and_padding', () => {
  jest.setTimeout(TIMEOUT);

  /** How many padding items the hook adds to each kind of side effect, in each phase of the tx. */
  const PADDING_PER_PHASE = 2;

  let wallet: TestWallet;
  let aztecNode: AztecNode;
  let defaultAccountAddress: AztecAddress;
  let teardown: () => Promise<void>;
  let testLogContract: TestLogContract;
  let testContract: TestContract;

  /** What the hook does to the txs the running test sends. Setup txs keep PXE's defaults. */
  let hookBehavior: 'keep-defaults' | 'pad-side-effects' | 'lower-expiry' = 'keep-defaults';
  let lastResolution: ExpirationAndPadding | undefined;

  const resolveExpirationAndPadding: ResolveExpirationAndPadding = request => {
    const resolution: ExpirationAndPadding = {
      expirationTimestamp: roundDownTxExpirationTimestamp(request),
      sideEffects: request.minSideEffects,
    };
    if (hookBehavior === 'pad-side-effects') {
      resolution.sideEffects = padSideEffectCounts(request.minSideEffects, PADDING_PER_PHASE);
    } else if (hookBehavior === 'lower-expiry') {
      // One second below the maximum and not rounded, unlike the expiry PXE publishes without the hook.
      resolution.expirationTimestamp = request.maxExpirationTimestamp - 1n;
    }
    lastResolution = resolution;
    return Promise.resolve(resolution);
  };

  /** The counts of each kind of side effect across the tx's phases, which the mined tx no longer tells apart. */
  const sumPhases = (counts: TxSideEffectCounts): SideEffectCounts =>
    counts.isPrivateOnlyTx
      ? { noteHashes: counts.noteHashes, nullifiers: counts.nullifiers, privateLogs: counts.privateLogs }
      : {
          noteHashes: counts.nonRevertible.noteHashes + counts.revertible.noteHashes,
          nullifiers: counts.nonRevertible.nullifiers + counts.revertible.nullifiers,
          privateLogs: counts.nonRevertible.privateLogs + counts.revertible.privateLogs,
        };

  const getMinedCounts = async (txHash: TxHash): Promise<SideEffectCounts> => {
    const txEffect = await aztecNode.getTxEffect(txHash);
    if (!txEffect) {
      throw new Error(`No tx effect found for mined tx ${txHash}`);
    }
    const { noteHashes, nullifiers, privateLogs } = txEffect.data;
    return { noteHashes: noteHashes.length, nullifiers: nullifiers.length, privateLogs: privateLogs.length };
  };

  beforeAll(async () => {
    ({
      teardown,
      wallet,
      aztecNode,
      accounts: [defaultAccountAddress],
    } = (
      await AutomineTestContext.setup({
        numberOfAccounts: 1,
        pxeCreationOptions: { hooks: { resolveExpirationAndPadding } },
      })
    ).context);

    ({ contract: testLogContract } = await TestLogContract.deploy(wallet).send({ from: defaultAccountAddress }));
    ({ contract: testContract } = await TestContract.deploy(wallet).send({ from: defaultAccountAddress }));
  });

  afterAll(() => teardown());

  beforeEach(() => {
    hookBehavior = 'keep-defaults';
    lastResolution = undefined;
  });

  it('mines a private-only tx with its side effects padded', async () => {
    hookBehavior = 'pad-side-effects';

    const { receipt } = await testLogContract.methods
      .deliver_squashed_and_surviving_notes(defaultAccountAddress)
      .send({ from: defaultAccountAddress });

    expect(lastResolution?.sideEffects.isPrivateOnlyTx).toBe(true);
    expect(await getMinedCounts(receipt.txHash)).toEqual(sumPhases(lastResolution!.sideEffects));
  });

  it('mines a tx with public calls with both phases padded', async () => {
    hookBehavior = 'pad-side-effects';

    const { receipt } = await new BatchCall(wallet, [
      testLogContract.methods.deliver_squashed_and_surviving_notes(defaultAccountAddress),
      // Enqueues a public call that emits no side effects, so all of the tx's published side effects are private.
      testContract.methods.call_create_note(1n, defaultAccountAddress, Fr.random(), true),
    ]).send({ from: defaultAccountAddress });

    expect(lastResolution?.sideEffects.isPrivateOnlyTx).toBe(false);
    expect(await getMinedCounts(receipt.txHash)).toEqual(sumPhases(lastResolution!.sideEffects));
  });

  it('mines only the non-revertible padding of a tx whose public execution reverts', async () => {
    hookBehavior = 'pad-side-effects';
    const nullifier = Fr.random();

    const { receipt } = await new BatchCall(wallet, [
      testLogContract.methods.deliver_squashed_and_surviving_notes(defaultAccountAddress),
      // Emitting the same nullifier twice reverts public execution, which discards the tx's revertible side effects.
      testContract.methods.emit_nullifier_public(nullifier),
      testContract.methods.emit_nullifier_public(nullifier),
    ]).send({ from: defaultAccountAddress, wait: { dontThrowOnRevert: true } });

    expect(receipt.executionResult).toEqual(TxExecutionResult.REVERTED);
    const sideEffects = lastResolution?.sideEffects;
    if (!sideEffects || sideEffects.isPrivateOnlyTx) {
      throw new Error(`Expected the hook to resolve a tx with public calls, got ${JSON.stringify(sideEffects)}`);
    }
    expect(await getMinedCounts(receipt.txHash)).toEqual(sideEffects.nonRevertible);
  });

  it('publishes the expiry the hook lowers below the maximum', async () => {
    hookBehavior = 'lower-expiry';

    const tx = await proveInteraction(
      wallet,
      testLogContract.methods.deliver_squashed_and_surviving_notes(defaultAccountAddress),
      { from: defaultAccountAddress },
    );
    await tx.send();

    expect(tx.data.expirationTimestamp).toEqual(lastResolution?.expirationTimestamp);
  });
});
