import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { IndexWithinCheckpoint, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Secp256k1Signer } from '@aztec-labs/foundation/crypto/secp256k1-signer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import { EmptyL1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import type { P2PClient } from '@aztec-labs/stdlib/interfaces/server';
import type { BlockProposal, CheckpointProposalCore } from '@aztec-labs/stdlib/p2p';
import { OffenseType } from '@aztec-labs/stdlib/slashing';
import {
  makeBlockHeader,
  makeBlockProposal,
  makeCheckpointHeader,
  makeCheckpointProposal,
} from '@aztec-labs/stdlib/testing';
import { jest } from '@jest/globals';
import { type MockProxy, mock } from 'jest-mock-extended';

import { DefaultSlasherConfig, type SlasherConfig } from '../config.js';
import { WANT_TO_SLASH_EVENT, type WantToSlashArgs } from '../watcher.js';
import { BroadcastedInvalidCheckpointProposalWatcher } from './broadcasted_invalid_checkpoint_proposal_watcher.js';

describe('BroadcastedInvalidCheckpointProposalWatcher', () => {
  let p2pClient: MockProxy<Pick<P2PClient, 'getProposalsForSlot'>>;
  let l2BlockSource: MockProxy<Pick<L2BlockSource, 'getSyncedL2SlotNumber'>>;
  let epochCache: MockProxy<Pick<EpochCacheInterface, 'getSlotNow' | 'getL1Constants'>>;
  let config: SlasherConfig;
  let watcher: BroadcastedInvalidCheckpointProposalWatcher;
  let handler: jest.MockedFunction<(args: WantToSlashArgs[]) => void>;

  beforeEach(() => {
    p2pClient = mock<Pick<P2PClient, 'getProposalsForSlot'>>();
    l2BlockSource = mock<Pick<L2BlockSource, 'getSyncedL2SlotNumber'>>();
    l2BlockSource.getSyncedL2SlotNumber.mockResolvedValue(SlotNumber(12));
    epochCache = mock<Pick<EpochCacheInterface, 'getSlotNow' | 'getL1Constants'>>();
    epochCache.getSlotNow.mockReturnValue(SlotNumber(12));
    epochCache.getL1Constants.mockReturnValue({
      ...EmptyL1RollupConstants,
      epochDuration: 8,
      ethereumSlotDuration: 12,
    });
    config = {
      ...DefaultSlasherConfig,
      slashBroadcastedInvalidCheckpointProposalPenalty: 11n,
      slashDuplicateProposalPenalty: 23n,
    };
    watcher = new BroadcastedInvalidCheckpointProposalWatcher(p2pClient, l2BlockSource, epochCache, config, 4);
    handler = jest.fn();
    watcher.on(WANT_TO_SLASH_EVENT, handler);
  });

  const makeBlocks = async (signer: Secp256k1Signer, slot: SlotNumber, count: number): Promise<BlockProposal[]> =>
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        makeBlockProposal({
          signer,
          blockHeader: makeBlockHeader(index + 1, { slotNumber: slot }),
          archiveRoot: Fr.random(),
          indexWithinCheckpoint: IndexWithinCheckpoint(index),
        }),
      ),
    );

  const makeCheckpointCore = async (
    signer: Secp256k1Signer,
    slot: SlotNumber,
    terminalBlock: BlockProposal,
    includeLastBlock = false,
  ): Promise<CheckpointProposalCore> => {
    const checkpoint = await makeCheckpointProposal({
      signer,
      checkpointHeader: makeCheckpointHeader(1, { slotNumber: slot }),
      archiveRoot: terminalBlock.archive,
      lastBlock: includeLastBlock
        ? {
            blockHeader: terminalBlock.blockHeader,
            indexWithinCheckpoint: terminalBlock.indexWithinCheckpoint,
            txHashes: terminalBlock.txHashes,
          }
        : undefined,
    });
    return checkpoint.toCore();
  };

  const mockProposals = (
    slot: SlotNumber,
    blockProposals: BlockProposal[],
    checkpointProposals: CheckpointProposalCore[],
  ) =>
    p2pClient.getProposalsForSlot.mockImplementation(querySlot =>
      Promise.resolve(
        querySlot === slot ? { blockProposals, checkpointProposals } : { blockProposals: [], checkpointProposals: [] },
      ),
    );

  it('slashes when higher-index block proposals arrive before a truncated checkpoint proposal', async () => {
    const signer = Secp256k1Signer.random();
    const slot = SlotNumber(10);
    const blocks = await makeBlocks(signer, slot, 4);
    const checkpoint = await makeCheckpointCore(signer, slot, blocks[1]);
    mockProposals(slot, blocks, [checkpoint]);

    await watcher.scanSlot(slot);

    expect(handler).toHaveBeenCalledWith([
      {
        validator: signer.address,
        amount: 11n,
        offenseType: OffenseType.BROADCASTED_INVALID_CHECKPOINT_PROPOSAL,
        epochOrSlot: 10n,
      },
    ]);
  });

  it('slashes when a higher-index proposal arrives after an earlier non-slashing scan', async () => {
    const signer = Secp256k1Signer.random();
    const slot = SlotNumber(10);
    const blocks = await makeBlocks(signer, slot, 4);
    const checkpoint = await makeCheckpointCore(signer, slot, blocks[1]);
    mockProposals(slot, blocks.slice(0, 2), [checkpoint]);

    await watcher.scanSlot(slot);
    expect(handler).not.toHaveBeenCalled();

    mockProposals(slot, blocks, [checkpoint]);
    await watcher.scanSlot(slot);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0][0].validator).toEqual(signer.address);
  });

  it('infers the terminal proposal from a retained block reconstructed out of embedded lastBlock', async () => {
    const signer = Secp256k1Signer.random();
    const slot = SlotNumber(10);
    const blocks = await makeBlocks(signer, slot, 4);
    const checkpointWithLastBlock = await makeCheckpointProposal({
      signer,
      checkpointHeader: makeCheckpointHeader(1, { slotNumber: slot }),
      archiveRoot: blocks[1].archive,
      lastBlock: {
        blockHeader: blocks[1].blockHeader,
        indexWithinCheckpoint: blocks[1].indexWithinCheckpoint,
        txHashes: blocks[1].txHashes,
      },
    });
    mockProposals(slot, [checkpointWithLastBlock.getBlockProposal()!, blocks[2]], [checkpointWithLastBlock.toCore()]);

    await watcher.scanSlot(slot);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0][0].validator).toEqual(signer.address);
  });

  it('does not slash when the checkpoint terminates at the highest known block', async () => {
    const signer = Secp256k1Signer.random();
    const slot = SlotNumber(10);
    const blocks = await makeBlocks(signer, slot, 4);
    const checkpoint = await makeCheckpointCore(signer, slot, blocks[3]);
    mockProposals(slot, blocks, [checkpoint]);

    await watcher.scanSlot(slot);

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not slash without a matching signed terminal block proposal', async () => {
    const signer = Secp256k1Signer.random();
    const slot = SlotNumber(10);
    const blocks = await makeBlocks(signer, slot, 4);
    const missingTerminal = await makeBlockProposal({
      signer,
      blockHeader: makeBlockHeader(99, { slotNumber: slot }),
      archiveRoot: Fr.random(),
      indexWithinCheckpoint: IndexWithinCheckpoint(1),
    });
    const checkpoint = await makeCheckpointCore(signer, slot, missingTerminal);
    mockProposals(slot, blocks, [checkpoint]);

    await watcher.scanSlot(slot);

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not slash when the higher-index block is signed by a different validator', async () => {
    const signer = Secp256k1Signer.random();
    const otherSigner = Secp256k1Signer.random();
    const slot = SlotNumber(10);
    const blocks = await makeBlocks(signer, slot, 2);
    const higherBlock = (await makeBlocks(otherSigner, slot, 3))[2];
    const checkpoint = await makeCheckpointCore(signer, slot, blocks[1]);
    mockProposals(slot, [...blocks, higherBlock], [checkpoint]);

    await watcher.scanSlot(slot);

    expect(handler).not.toHaveBeenCalled();
  });

  it('emits zero-amount offenses when the penalty is zero', async () => {
    const signer = Secp256k1Signer.random();
    const slot = SlotNumber(10);
    const blocks = await makeBlocks(signer, slot, 4);
    const checkpoint = await makeCheckpointCore(signer, slot, blocks[1]);
    watcher.updateConfig({ slashBroadcastedInvalidCheckpointProposalPenalty: 0n });
    mockProposals(slot, blocks, [checkpoint]);

    await watcher.scanSlot(slot);

    expect(handler).toHaveBeenCalledWith([
      {
        validator: signer.address,
        amount: 0n,
        offenseType: OffenseType.BROADCASTED_INVALID_CHECKPOINT_PROPOSAL,
        epochOrSlot: 10n,
      },
    ]);
  });

  it('does not emit duplicate offenses on repeated scans', async () => {
    const signer = Secp256k1Signer.random();
    const slot = SlotNumber(10);
    const blocks = await makeBlocks(signer, slot, 4);
    const checkpoint = await makeCheckpointCore(signer, slot, blocks[1]);
    mockProposals(slot, blocks, [checkpoint]);

    await watcher.scanSlot(slot);
    await watcher.scanSlot(slot);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('scans a lookback of closed slots', async () => {
    const signer = Secp256k1Signer.random();
    const slot = SlotNumber(10);
    const blocks = await makeBlocks(signer, slot, 4);
    const checkpoint = await makeCheckpointCore(signer, slot, blocks[1]);
    mockProposals(slot, blocks, [checkpoint]);

    await watcher.scan();

    expect(p2pClient.getProposalsForSlot).toHaveBeenCalledWith(SlotNumber(7));
    expect(p2pClient.getProposalsForSlot).toHaveBeenCalledWith(SlotNumber(10));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('anchors the scan at the archiver synced L2 slot, not the wallclock', async () => {
    p2pClient.getProposalsForSlot.mockResolvedValue({ blockProposals: [], checkpointProposals: [] });
    l2BlockSource.getSyncedL2SlotNumber.mockResolvedValue(SlotNumber(9));
    epochCache.getSlotNow.mockReturnValue(SlotNumber(20));

    await watcher.scan();

    expect(p2pClient.getProposalsForSlot.mock.calls.map(([slot]) => slot)).toEqual([
      SlotNumber(4),
      SlotNumber(5),
      SlotNumber(6),
      SlotNumber(7),
    ]);
  });

  it('falls back to the wallclock when the archiver has not yet synced', async () => {
    p2pClient.getProposalsForSlot.mockResolvedValue({ blockProposals: [], checkpointProposals: [] });
    l2BlockSource.getSyncedL2SlotNumber.mockResolvedValue(undefined);
    epochCache.getSlotNow.mockReturnValue(SlotNumber(12));

    await watcher.scan();

    expect(p2pClient.getProposalsForSlot.mock.calls.map(([slot]) => slot)).toEqual([
      SlotNumber(7),
      SlotNumber(8),
      SlotNumber(9),
      SlotNumber(10),
    ]);
  });

  it('does not expand the scan window when L1 stalls but wallclock keeps moving', async () => {
    p2pClient.getProposalsForSlot.mockResolvedValue({ blockProposals: [], checkpointProposals: [] });
    l2BlockSource.getSyncedL2SlotNumber.mockResolvedValue(SlotNumber(12));
    epochCache.getSlotNow.mockReturnValue(SlotNumber(12));

    await watcher.scan();
    p2pClient.getProposalsForSlot.mockClear();
    epochCache.getSlotNow.mockReturnValue(SlotNumber(50));

    await watcher.scan();

    expect(p2pClient.getProposalsForSlot.mock.calls.map(([slot]) => slot)).toEqual([
      SlotNumber(7),
      SlotNumber(8),
      SlotNumber(9),
      SlotNumber(10),
    ]);
  });

  it('only expands beyond the lookback for newly closed slots', async () => {
    p2pClient.getProposalsForSlot.mockResolvedValue({ blockProposals: [], checkpointProposals: [] });

    await watcher.scan();
    p2pClient.getProposalsForSlot.mockClear();
    l2BlockSource.getSyncedL2SlotNumber.mockResolvedValue(SlotNumber(13));

    await watcher.scan();

    expect(p2pClient.getProposalsForSlot.mock.calls.map(([slot]) => slot)).toEqual([
      SlotNumber(8),
      SlotNumber(9),
      SlotNumber(10),
      SlotNumber(11),
    ]);
  });

  describe('duplicate proposals', () => {
    const slot = SlotNumber(10);

    const makeBlockAt = (signer: Secp256k1Signer, index: number): Promise<BlockProposal> =>
      makeBlockProposal({
        signer,
        blockHeader: makeBlockHeader(index + 1, { slotNumber: slot }),
        archiveRoot: Fr.random(),
        indexWithinCheckpoint: IndexWithinCheckpoint(index),
      });

    const makeCheckpointAt = async (signer: Secp256k1Signer): Promise<CheckpointProposalCore> =>
      (
        await makeCheckpointProposal({
          signer,
          checkpointHeader: makeCheckpointHeader(1, { slotNumber: slot }),
          archiveRoot: Fr.random(),
        })
      ).toCore();

    const emittedOffenses = () => handler.mock.calls.flatMap(([args]) => args);

    const duplicateOffense = (signer: Secp256k1Signer) => ({
      validator: signer.address,
      amount: 23n,
      offenseType: OffenseType.DUPLICATE_PROPOSAL,
      epochOrSlot: BigInt(slot),
    });

    it('slashes a signer with two block payloads at the same index', async () => {
      const signer = Secp256k1Signer.random();
      mockProposals(slot, [await makeBlockAt(signer, 0), await makeBlockAt(signer, 0)], []);

      await watcher.scanSlot(slot);

      expect(emittedOffenses()).toEqual([duplicateOffense(signer)]);
    });

    it('does not slash two signers with one payload each at the same index', async () => {
      const first = Secp256k1Signer.random();
      const second = Secp256k1Signer.random();
      mockProposals(slot, [await makeBlockAt(first, 0), await makeBlockAt(second, 0)], []);

      await watcher.scanSlot(slot);

      expect(emittedOffenses()).toEqual([]);
    });

    it('slashes a signer with two checkpoint payloads in the slot', async () => {
      const signer = Secp256k1Signer.random();
      mockProposals(slot, [], [await makeCheckpointAt(signer), await makeCheckpointAt(signer)]);

      await watcher.scanSlot(slot);

      expect(emittedOffenses()).toEqual([duplicateOffense(signer)]);
    });

    it('does not slash two signers with one checkpoint payload each in the slot', async () => {
      const first = Secp256k1Signer.random();
      const second = Secp256k1Signer.random();
      mockProposals(slot, [], [await makeCheckpointAt(first), await makeCheckpointAt(second)]);

      await watcher.scanSlot(slot);

      expect(emittedOffenses()).toEqual([]);
    });

    it('emits a single offense when a signer duplicates both a block and the checkpoint', async () => {
      const signer = Secp256k1Signer.random();
      mockProposals(
        slot,
        [await makeBlockAt(signer, 0), await makeBlockAt(signer, 0)],
        [await makeCheckpointAt(signer), await makeCheckpointAt(signer)],
      );

      await watcher.scanSlot(slot);

      expect(emittedOffenses()).toEqual([duplicateOffense(signer)]);
    });

    it('does not slash a signer with payloads at different indexes', async () => {
      const signer = Secp256k1Signer.random();
      mockProposals(slot, [await makeBlockAt(signer, 0), await makeBlockAt(signer, 1)], []);

      await watcher.scanSlot(slot);

      expect(emittedOffenses()).toEqual([]);
    });

    it('ignores proposals with no recoverable signer', async () => {
      const unsignedBlocks = [
        await makeBlockAt(Secp256k1Signer.random(), 0),
        await makeBlockAt(Secp256k1Signer.random(), 0),
      ];
      const unsignedCheckpoints = [
        await makeCheckpointAt(Secp256k1Signer.random()),
        await makeCheckpointAt(Secp256k1Signer.random()),
      ];
      for (const proposal of [...unsignedBlocks, ...unsignedCheckpoints]) {
        jest.spyOn(proposal, 'getSender').mockReturnValue(undefined);
      }
      mockProposals(slot, unsignedBlocks, unsignedCheckpoints);

      await watcher.scanSlot(slot);

      expect(emittedOffenses()).toEqual([]);
    });

    it('does not emit the same offense again when rescanning the slot', async () => {
      const signer = Secp256k1Signer.random();
      mockProposals(slot, [await makeBlockAt(signer, 0), await makeBlockAt(signer, 0)], []);

      await watcher.scanSlot(slot);
      await watcher.scanSlot(slot);
      await watcher.scan();

      expect(emittedOffenses()).toEqual([duplicateOffense(signer)]);
    });

    it('emits each offense once when several signers offend in one slot across the scan window', async () => {
      const equivocators = Array.from({ length: 5 }, () => Secp256k1Signer.random());
      const duplicateBlocks = (
        await Promise.all(
          equivocators.map(async (signer, index) => [
            await makeBlockAt(signer, index),
            await makeBlockAt(signer, index),
          ]),
        )
      ).flat();
      const truncator = Secp256k1Signer.random();
      const truncatorBlocks = await makeBlocks(truncator, slot, 4);
      const truncatedCheckpoint = await makeCheckpointCore(truncator, slot, truncatorBlocks[1]);
      mockProposals(slot, [...duplicateBlocks, ...truncatorBlocks], [truncatedCheckpoint]);

      // Slot 10 stays in the scan window while the archiver syncs slots 12 through 15, and leaves it at 16.
      for (let syncedSlot = 12; syncedSlot <= 16; syncedSlot++) {
        l2BlockSource.getSyncedL2SlotNumber.mockResolvedValue(SlotNumber(syncedSlot));
        await watcher.scan();
        await watcher.scan();
      }

      const offenses = emittedOffenses();
      expect(offenses).toHaveLength(equivocators.length + 1);
      expect(offenses).toEqual(
        expect.arrayContaining([
          ...equivocators.map(duplicateOffense),
          {
            validator: truncator.address,
            amount: 11n,
            offenseType: OffenseType.BROADCASTED_INVALID_CHECKPOINT_PROPOSAL,
            epochOrSlot: BigInt(slot),
          },
        ]),
      );
    });

    it('slashes a truncated checkpoint and a duplicate block from the same signer in one slot', async () => {
      const signer = Secp256k1Signer.random();
      const blocks = await makeBlocks(signer, slot, 4);
      const checkpoint = await makeCheckpointCore(signer, slot, blocks[1]);
      const duplicateBlock = await makeBlockAt(signer, 2);
      mockProposals(slot, [...blocks, duplicateBlock], [checkpoint]);

      await watcher.scanSlot(slot);

      expect(emittedOffenses()).toEqual([
        {
          validator: signer.address,
          amount: 11n,
          offenseType: OffenseType.BROADCASTED_INVALID_CHECKPOINT_PROPOSAL,
          epochOrSlot: BigInt(slot),
        },
        duplicateOffense(signer),
      ]);
    });

    it('picks up a duplicate proposal penalty change', async () => {
      const signer = Secp256k1Signer.random();
      watcher.updateConfig({ slashDuplicateProposalPenalty: 0n });
      mockProposals(slot, [await makeBlockAt(signer, 0), await makeBlockAt(signer, 0)], []);

      await watcher.scanSlot(slot);

      expect(emittedOffenses()).toEqual([{ ...duplicateOffense(signer), amount: 0n }]);
    });
  });
});
