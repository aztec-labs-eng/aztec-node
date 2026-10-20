import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { IndexWithinCheckpoint, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Secp256k1Signer } from '@aztec-labs/foundation/crypto/secp256k1-signer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { AztecAsyncKVStore } from '@aztec-labs/kv-store';
import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { AttestationPool } from '@aztec-labs/p2p';
import {
  BroadcastedInvalidCheckpointProposalWatcher,
  DefaultSlasherConfig,
  OffenseType,
  WANT_TO_SLASH_EVENT,
  type WantToSlashArgs,
} from '@aztec-labs/slasher';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import { EmptyL1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import type { CheckpointProposal } from '@aztec-labs/stdlib/p2p';
import {
  makeBlockHeader,
  makeBlockProposal,
  makeCheckpointHeader,
  makeCheckpointProposal,
} from '@aztec-labs/stdlib/testing';
import { TxHash } from '@aztec-labs/stdlib/tx';
import { type MockProxy, mock } from 'jest-mock-extended';

describe('DUPLICATE_PROPOSAL attribution from the attestation pool', () => {
  const slot = SlotNumber(10);
  const penalty = 23n;

  let store: AztecAsyncKVStore;
  let pool: AttestationPool;
  let watcher: BroadcastedInvalidCheckpointProposalWatcher;
  let offenses: WantToSlashArgs[];

  beforeEach(async () => {
    store = await openTmpStore('duplicate-proposal-watcher');
    pool = new AttestationPool(store);

    const l2BlockSource: MockProxy<Pick<L2BlockSource, 'getSyncedL2SlotNumber'>> = mock();
    const epochCache: MockProxy<Pick<EpochCacheInterface, 'getSlotNow' | 'getL1Constants'>> = mock();
    epochCache.getL1Constants.mockReturnValue({ ...EmptyL1RollupConstants, ethereumSlotDuration: 12 });
    watcher = new BroadcastedInvalidCheckpointProposalWatcher(pool, l2BlockSource, epochCache, {
      ...DefaultSlasherConfig,
      slashDuplicateProposalPenalty: penalty,
    });

    offenses = [];
    watcher.on(WANT_TO_SLASH_EVENT, args => offenses.push(...args));
  });

  afterEach(async () => {
    await store.close();
  });

  const duplicateOffense = (signer: Secp256k1Signer): WantToSlashArgs => ({
    validator: signer.address,
    amount: penalty,
    offenseType: OffenseType.DUPLICATE_PROPOSAL,
    epochOrSlot: BigInt(slot),
  });

  /**
   * Stores a gossiped checkpoint the way the p2p service does: the embedded last block first, then the checkpoint
   * only if that position holds no other block payload, whether the last block is new or already held. The pool
   * reports the position's full count even for a block it already holds, so a checkpoint whose last block shares its
   * position with another payload is dropped, as is one whose last block hit the per-position cap.
   */
  const receiveCheckpoint = async (checkpoint: CheckpointProposal) => {
    const lastBlock = await pool.tryAddBlockProposal(checkpoint.getBlockProposal()!);
    if (lastBlock.count === 1) {
      await pool.tryAddCheckpointProposal(checkpoint.toCore());
    }
  };

  const makeBlock = (signer: Secp256k1Signer, payload: Partial<Parameters<typeof makeBlockProposal>[0]> = {}) =>
    makeBlockProposal({
      signer,
      blockHeader: makeBlockHeader(1, { slotNumber: slot }),
      indexWithinCheckpoint: IndexWithinCheckpoint(0),
      archiveRoot: Fr.random(),
      ...payload,
    });

  it('slashes a signer whose checkpoints embed different terminal blocks at the same index', async () => {
    const signer = Secp256k1Signer.random();
    const lastBlock = {
      blockHeader: makeBlockHeader(1, { slotNumber: slot }),
      indexWithinCheckpoint: IndexWithinCheckpoint(0),
    };
    const makeCheckpoint = () =>
      makeCheckpointProposal({
        signer,
        checkpointHeader: makeCheckpointHeader(1, { slotNumber: slot }),
        archiveRoot: Fr.random(),
        lastBlock,
      });

    await receiveCheckpoint(await makeCheckpoint());
    await receiveCheckpoint(await makeCheckpoint());
    await watcher.scanSlot(slot);

    // Only the first checkpoint is retained; the equivocation shows in the two retained terminal blocks.
    const retained = await pool.getProposalsForSlot(slot);
    expect(retained.checkpointProposals).toHaveLength(1);
    expect(retained.blockProposals).toHaveLength(2);
    expect(offenses).toEqual([duplicateOffense(signer)]);
  });

  it('does not slash two signers that each propose one block at the same index', async () => {
    const first = Secp256k1Signer.random();
    const second = Secp256k1Signer.random();

    expect(await pool.tryAddBlockProposal(await makeBlock(first))).toMatchObject({ added: true, count: 1 });
    expect(await pool.tryAddBlockProposal(await makeBlock(second))).toMatchObject({ added: true, count: 2 });
    await watcher.scanSlot(slot);

    expect(offenses).toEqual([]);
  });

  it('misses an equivocation when another signer first signed an identical payload (known limit)', async () => {
    // The pool stores a payload once, whoever signed it, so B's copy of X is dropped as already known and the pool
    // retains A's X and B's Y: one payload per signer at the position, which reads as no equivocation.
    const a = Secp256k1Signer.random();
    const b = Secp256k1Signer.random();
    const payloadX = {
      archiveRoot: Fr.random(),
      txHashes: [TxHash.random()],
      inboxPrefixRef: (await makeBlock(a)).inboxPrefixRef,
    };
    const aSignsX = await makeBlock(a, payloadX);
    const bSignsX = await makeBlock(b, payloadX);
    const bSignsY = await makeBlock(b);

    expect(await pool.tryAddBlockProposal(aSignsX)).toMatchObject({ added: true });
    expect(await pool.tryAddBlockProposal(bSignsX)).toMatchObject({ added: false, alreadyExists: true });
    expect(await pool.tryAddBlockProposal(bSignsY)).toMatchObject({ added: true });
    await watcher.scanSlot(slot);

    expect(offenses).toEqual([]);
  });
});
