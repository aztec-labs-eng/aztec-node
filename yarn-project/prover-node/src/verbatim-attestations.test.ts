import type { CalldataRetriever } from '@aztec-labs/archiver';
import type { CheckpointProposedLog, RollupContract, ViemCommitteeAttestations } from '@aztec-labs/ethereum/contracts';
import { CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import { L1PublishedData, type PublishedCheckpoint } from '@aztec-labs/stdlib/checkpoint';
import { type MockProxy, mock } from 'jest-mock-extended';

import { L1VerbatimAttestationsSource, VerbatimAttestationsUnavailableError } from './verbatim-attestations.js';

describe('L1VerbatimAttestationsSource', () => {
  const checkpointNumber = CheckpointNumber(64);
  const l1BlockNumber = 4242n;
  const attestationsHash = Buffer32.random();
  const payloadDigest = Buffer32.random();
  const l1TransactionHash = Buffer32.random().toString();
  const posted: ViemCommitteeAttestations = { signatureIndices: '0x01', signaturesOrAddresses: '0xdeadbeef' };

  let l2BlockSource: MockProxy<Pick<L2BlockSource, 'getCheckpoint'>>;
  let rollupContract: MockProxy<Pick<RollupContract, 'getCheckpoint' | 'getCheckpointProposedEvents'>>;
  let calldataRetriever: MockProxy<Pick<CalldataRetriever, 'getCheckpointFromRollupTx'>>;
  let source: L1VerbatimAttestationsSource;

  const makeEvent = (
    overrides: Partial<CheckpointProposedLog['args']> = {},
    txHash = l1TransactionHash,
  ): CheckpointProposedLog => ({
    l1BlockNumber,
    l1BlockHash: Buffer32.random(),
    l1TransactionHash: txHash,
    args: {
      checkpointNumber,
      archive: Fr.random(),
      versionedBlobHashes: [],
      attestationsHash,
      payloadDigest,
      ...overrides,
    },
  });

  beforeEach(() => {
    l2BlockSource = mock<Pick<L2BlockSource, 'getCheckpoint'>>();
    l2BlockSource.getCheckpoint.mockResolvedValue({
      l1: new L1PublishedData(l1BlockNumber, 0n, Buffer32.random().toString()),
    } as PublishedCheckpoint);

    rollupContract = mock<Pick<RollupContract, 'getCheckpoint' | 'getCheckpointProposedEvents'>>();
    rollupContract.getCheckpoint.mockResolvedValue({ attestationsHash, payloadDigest } as Awaited<
      ReturnType<RollupContract['getCheckpoint']>
    >);
    rollupContract.getCheckpointProposedEvents.mockResolvedValue([makeEvent()]);

    calldataRetriever = mock<Pick<CalldataRetriever, 'getCheckpointFromRollupTx'>>();
    calldataRetriever.getCheckpointFromRollupTx.mockResolvedValue({ verbatimAttestations: posted } as Awaited<
      ReturnType<CalldataRetriever['getCheckpointFromRollupTx']>
    >);

    source = new L1VerbatimAttestationsSource({ l2BlockSource, rollupContract, calldataRetriever });
  });

  it('returns the tuple decoded from the propose calldata', async () => {
    await expect(source.getVerbatimAttestations(checkpointNumber)).resolves.toEqual(posted);
  });

  it('asks the retriever to verify against the hash the rollup stored', async () => {
    await source.getVerbatimAttestations(checkpointNumber);

    expect(calldataRetriever.getCheckpointFromRollupTx).toHaveBeenCalledWith(l1TransactionHash, [], checkpointNumber, {
      attestationsHash: attestationsHash.toString(),
      payloadDigest: payloadDigest.toString(),
    });
  });

  it('queries only the L1 block the checkpoint was proposed in', async () => {
    await source.getVerbatimAttestations(checkpointNumber);

    expect(rollupContract.getCheckpointProposedEvents).toHaveBeenCalledWith(l1BlockNumber, l1BlockNumber);
  });

  it('throws when the block source does not know the checkpoint', async () => {
    l2BlockSource.getCheckpoint.mockResolvedValue(undefined);

    await expect(source.getVerbatimAttestations(checkpointNumber)).rejects.toThrow(
      VerbatimAttestationsUnavailableError,
    );
  });

  it('throws when no propose event on that block carries the stored attestations hash', async () => {
    rollupContract.getCheckpointProposedEvents.mockResolvedValue([makeEvent({ attestationsHash: Buffer32.random() })]);

    await expect(source.getVerbatimAttestations(checkpointNumber)).rejects.toThrow(
      VerbatimAttestationsUnavailableError,
    );
  });

  it('skips a propose event whose payload digest is not the one the rollup holds', async () => {
    const stale = makeEvent({ payloadDigest: Buffer32.random() }, Buffer32.random().toString());
    rollupContract.getCheckpointProposedEvents.mockResolvedValue([stale, makeEvent()]);

    await expect(source.getVerbatimAttestations(checkpointNumber)).resolves.toEqual(posted);
    expect(calldataRetriever.getCheckpointFromRollupTx).toHaveBeenCalledTimes(1);
    expect(calldataRetriever.getCheckpointFromRollupTx).not.toHaveBeenCalledWith(
      stale.l1TransactionHash,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('tries every matching event when an earlier propose tx does not decode', async () => {
    // A checkpoint invalidated and re-proposed in the same L1 block leaves two events the hashes cannot tell
    // apart; giving up on the first one that fails to decode would strand a provable checkpoint.
    const undecodable = makeEvent({}, Buffer32.random().toString());
    rollupContract.getCheckpointProposedEvents.mockResolvedValue([undecodable, makeEvent()]);
    calldataRetriever.getCheckpointFromRollupTx.mockRejectedValueOnce(new Error('hash mismatch for traced propose'));

    await expect(source.getVerbatimAttestations(checkpointNumber)).resolves.toEqual(posted);
    expect(calldataRetriever.getCheckpointFromRollupTx).toHaveBeenCalledTimes(2);
  });

  it('throws when the propose calldata cannot be decoded', async () => {
    calldataRetriever.getCheckpointFromRollupTx.mockRejectedValue(new Error('no matching propose call'));

    await expect(source.getVerbatimAttestations(checkpointNumber)).rejects.toThrow(
      VerbatimAttestationsUnavailableError,
    );
  });
});
