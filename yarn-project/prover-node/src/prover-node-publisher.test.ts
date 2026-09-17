import { RollupAbi } from '@aztec-foundation/l1-artifacts';

import { BatchedBlob } from '@aztec-labs/blob-lib/types';
import {
  type RollupContract,
  type ViemCommitteeAttestations,
  computeAttestationsHash,
} from '@aztec-labs/ethereum/contracts';
import { randomL1ContractAddresses } from '@aztec-labs/ethereum/l1-contract-addresses';
import type { L1TxUtils } from '@aztec-labs/ethereum/l1-tx-utils';
import { CheckpointNumber, EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { SecretValue } from '@aztec-labs/foundation/config';
import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { bufferToHex } from '@aztec-labs/foundation/string';
import type { PublisherConfig, TxSenderConfig } from '@aztec-labs/sequencer-client';
import { CommitteeAttestation, CommitteeAttestationsAndSigners } from '@aztec-labs/stdlib/block';
import { Proof } from '@aztec-labs/stdlib/proofs';
import { CheckpointHeader, RootRollupPublicInputs } from '@aztec-labs/stdlib/rollup';
import { jest } from '@jest/globals';
import { type MockProxy, mock } from 'jest-mock-extended';
import { decodeFunctionData, getAddress } from 'viem';

import { ProverNodePublisher } from './prover-node-publisher.js';
import type { VerbatimAttestationsSource } from './verbatim-attestations.js';

/**
 * A packed attestations tuple for a committee of `committeeSize`, optionally with one of the bitmap's spare bits
 * set. Spare bits exist whenever the committee size is not a multiple of eight: no decoder on either side reads
 * them, but the `attestationsHash` the rollup stores at propose time covers them.
 */
const makePackedAttestations = (committeeSize: number, { spareBit = false } = {}): ViemCommitteeAttestations => {
  const attestations = Array.from({ length: committeeSize }, () =>
    CommitteeAttestation.fromAddress(EthAddress.random()),
  );
  const packed = CommitteeAttestationsAndSigners.packAttestations(attestations);
  if (!spareBit) {
    return packed;
  }
  const bitmap = Buffer.from(packed.signatureIndices.slice(2), 'hex');
  // Bit 0 of the last byte is committee position `8 * bitmap.length - 1`, past the end of a committee of 3.
  bitmap[bitmap.length - 1] |= 1;
  return { ...packed, signatureIndices: bufferToHex(bitmap) };
};

const makeHeadersForRange = (fromCheckpoint: number, toCheckpoint: number) =>
  Array.from({ length: toCheckpoint - fromCheckpoint + 1 }, () => CheckpointHeader.random());

describe('prover-node-publisher', () => {
  // Prover publisher dependencies
  let rollup: MockProxy<RollupContract>;
  let l1Utils: MockProxy<L1TxUtils>;
  let verbatimAttestations: MockProxy<VerbatimAttestationsSource>;
  /** The tuple the checkpoint being proven was proposed with, as recovered from the propose calldata. */
  let postedAttestations: ViemCommitteeAttestations;

  let publisher: ProverNodePublisher;

  let config: TxSenderConfig & PublisherConfig;

  beforeEach(() => {
    rollup = mock<RollupContract>();
    rollup.getHasSubmittedProof.mockResolvedValue(false);
    l1Utils = mock<L1TxUtils>();
    postedAttestations = makePackedAttestations(3);
    verbatimAttestations = mock<VerbatimAttestationsSource>();
    verbatimAttestations.getVerbatimAttestations.mockImplementation(() => Promise.resolve(postedAttestations));

    config = {
      l1ChainId: 1,
      l1RpcUrls: ['http://localhost:8545'],
      l1DebugRpcUrls: [],
      publisherPrivateKeys: [new SecretValue('0x1234')],
      viemPollingIntervalMS: 1000,
      ...randomL1ContractAddresses(),
    };
  });

  beforeEach(() => {
    publisher = new ProverNodePublisher(config, {
      rollupContract: rollup,
      l1TxUtils: l1Utils,
      verbatimAttestations,
    });
  });

  const setupPublishData = (pending: number, proven: number, fromCheckpoint: number, toCheckpoint: number) => {
    // Create public inputs for every checkpoint
    const checkpoints = Array.from({ length: 100 }, () => {
      return RootRollupPublicInputs.random();
    });

    // Return the tips specified by the test
    rollup.getTips.mockResolvedValue({
      pending: CheckpointNumber(pending),
      proven: CheckpointNumber(proven),
    });

    // Frozen here so a test can change what the propose calldata yields and still face the stored hash.
    const onChainAttestationsHash = Buffer32.fromString(computeAttestationsHash(postedAttestations));

    // Return the requested checkpoint
    rollup.getCheckpoint.mockImplementation((checkpointNumber: CheckpointNumber) =>
      Promise.resolve({
        archive: checkpoints[checkpointNumber - 1].endArchiveRoot,
        attestationsHash: onChainAttestationsHash,
        payloadDigest: Buffer32.ZERO, // unused,
        headerHash: Buffer32.ZERO, // unused,
        blobCommitmentsHash: Buffer32.ZERO, // unused,
        outHash: '0x', // unused,
        slotNumber: SlotNumber(0), // unused,
        feeHeader: {
          excessMana: 0n, // unused
          manaUsed: 0n, // unused
          ethPerFeeAsset: 0n, // unused
          protocolFee: 0n, // unused
          proverCost: 0n, // unused
        },
      }),
    );

    // We have built a rollup proof of the range fromCheckpoint - toCheckpoint
    // so we need to set our archives and hashes accordingly
    const ourPublicInputs = RootRollupPublicInputs.random();
    ourPublicInputs.previousArchiveRoot = checkpoints[fromCheckpoint - 2]?.endArchiveRoot ?? Fr.ZERO;
    ourPublicInputs.endArchiveRoot = checkpoints[toCheckpoint - 1]?.endArchiveRoot ?? Fr.ZERO;

    const ourBatchedBlob = new BatchedBlob(
      ourPublicInputs.blobPublicInputs.blobCommitmentsHash,
      ourPublicInputs.blobPublicInputs.z,
      ourPublicInputs.blobPublicInputs.y,
      ourPublicInputs.blobPublicInputs.c,
      ourPublicInputs.blobPublicInputs.c.negate(), // Fill with dummy value
    );

    // Return our public inputs
    const totalFields = ourPublicInputs.toFields();
    rollup.getEpochProofPublicInputs.mockResolvedValue(totalFields);

    return {
      epochNumber: EpochNumber(2),
      kind: 'full' as const,
      fromCheckpoint: CheckpointNumber(fromCheckpoint),
      toCheckpoint: CheckpointNumber(toCheckpoint),
      publicInputs: ourPublicInputs,
      headers: makeHeadersForRange(fromCheckpoint, toCheckpoint),
      proof: Proof.empty(),
      batchedBlobInputs: ourBatchedBlob,
    };
  };

  const testCases: {
    pending: number;
    proven: number;
    fromCheckpoint: number;
    toCheckpoint: number;
    kind: 'full' | 'partial';
    expectedPublish: boolean;
    message?: string;
  }[] = [
    // Usual case of proving full epoch
    { pending: 65, proven: 32, fromCheckpoint: 33, toCheckpoint: 64, kind: 'full', expectedPublish: true, message: '' },
    // Failure case of proving beyond the pending chain
    {
      pending: 65,
      proven: 32,
      fromCheckpoint: 33,
      toCheckpoint: 66,
      kind: 'full',
      expectedPublish: false,
      message: 'Cannot submit epoch proof for 33-66 as proposed checkpoint is 65',
    },
    // Some successful partial epochs
    {
      pending: 33,
      proven: 32,
      fromCheckpoint: 33,
      toCheckpoint: 33,
      kind: 'partial',
      expectedPublish: true,
      message: '',
    },
    {
      pending: 65,
      proven: 32,
      fromCheckpoint: 33,
      toCheckpoint: 38,
      kind: 'partial',
      expectedPublish: true,
      message: '',
    },
    {
      pending: 40,
      proven: 32,
      fromCheckpoint: 33,
      toCheckpoint: 33,
      kind: 'partial',
      expectedPublish: true,
      message: '',
    },

    // Somebody else proved the entire epoch already

    // We try and prove the full epoch - succeeds
    { pending: 65, proven: 64, fromCheckpoint: 33, toCheckpoint: 64, kind: 'full', expectedPublish: true, message: '' },

    // We try and prove a partial epoch that falls short of the end - fails as pointless to publish
    {
      pending: 65,
      proven: 64,
      fromCheckpoint: 33,
      toCheckpoint: 35,
      kind: 'partial',
      expectedPublish: false,
      message: 'Cannot submit epoch proof for 33-35 as proven checkpoint is 64',
    },

    // Somebody else proved the entire epoch and then part of the next one, so the proven tip now sits
    // beyond our epoch. Our full-epoch proof is still accepted by L1 and still registers reward shares.
    {
      pending: 100,
      proven: 70,
      fromCheckpoint: 33,
      toCheckpoint: 64,
      kind: 'full',
      expectedPublish: true,
      message: '',
    },

    // Same situation, but ours is a partial proof - it can never match the epoch's longest proven length
    {
      pending: 100,
      proven: 70,
      fromCheckpoint: 33,
      toCheckpoint: 45,
      kind: 'partial',
      expectedPublish: false,
      message: 'Cannot submit epoch proof for 33-45 as proven checkpoint is 70',
    },

    // Somebody else partially proved the epoch already

    // We try and prove the rest of the epoch - succeeds
    {
      pending: 65,
      proven: 40,
      fromCheckpoint: 41,
      toCheckpoint: 64,
      kind: 'partial',
      expectedPublish: true,
      message: '',
    },

    // We try and prove all of the epoch - succeeds
    { pending: 65, proven: 40, fromCheckpoint: 33, toCheckpoint: 64, kind: 'full', expectedPublish: true, message: '' },

    // We try and partially prove the epoch after their proof - succeeds again
    {
      pending: 65,
      proven: 40,
      fromCheckpoint: 41,
      toCheckpoint: 45,
      kind: 'partial',
      expectedPublish: true,
      message: '',
    },

    // We try and partially prove the epoch on top of their proof - succeeds again
    {
      pending: 65,
      proven: 40,
      fromCheckpoint: 33,
      toCheckpoint: 45,
      kind: 'partial',
      expectedPublish: true,
      message: '',
    },

    // We try and partially prove the epoch and partially on top of their proof - succeeds again
    {
      pending: 65,
      proven: 40,
      fromCheckpoint: 35,
      toCheckpoint: 45,
      kind: 'partial',
      expectedPublish: true,
      message: '',
    },

    // We try and partially prove the epoch but less than was already proven - fails as pointless
    {
      pending: 65,
      proven: 40,
      fromCheckpoint: 33,
      toCheckpoint: 39,
      kind: 'partial',
      expectedPublish: false,
      message: 'Cannot submit epoch proof for 33-39 as proven checkpoint is 40',
    },

    // We try and partially prove the epoch but the same as was already proven - should possibly fail but succeeds for now, quite an edge case
    {
      pending: 65,
      proven: 40,
      fromCheckpoint: 33,
      toCheckpoint: 40,
      kind: 'partial',
      expectedPublish: true,
    },
  ];

  test.each(testCases)(
    'submits $kind proof for epoch with proposed checkpoint: $pending, proven checkpoint: $proven, fromCheckpoint: $fromCheckpoint, toCheckpoint: $toCheckpoint',
    async ({ pending, proven, fromCheckpoint, toCheckpoint, kind, expectedPublish, message }) => {
      const publishData = { ...setupPublishData(pending, proven, fromCheckpoint, toCheckpoint), kind };

      const result = await publisher
        .submitEpochProof(publishData)
        .then(() => 'Success')
        .catch(error => error.message);

      if (expectedPublish) {
        expect(result).toBe('Success');
        expect(l1Utils.sendAndMonitorTransaction).toHaveBeenCalled();
      } else {
        expect(result).toBe(message);
        expect(l1Utils.sendAndMonitorTransaction).not.toHaveBeenCalled();
      }
    },
  );

  it('reports already-submitted without sending when this prover has already submitted for the epoch', async () => {
    const args = setupPublishData(65, 32, 33, 64);
    rollup.getHasSubmittedProof.mockResolvedValue(true);

    await expect(publisher.submitEpochProof(args)).resolves.toEqual('already-submitted');
    expect(rollup.getHasSubmittedProof).toHaveBeenCalledWith(EpochNumber(2), 32, expect.anything());
    expect(l1Utils.sendAndMonitorTransaction).not.toHaveBeenCalled();
  });

  describe('committee attestations', () => {
    /** The `CommitteeAttestations` tuple of the mined submitEpochRootProof tx. */
    const submittedAttestations = (): ViemCommitteeAttestations => {
      const [{ data }] = l1Utils.sendAndMonitorTransaction.mock.calls[0];
      const decoded = decodeFunctionData({ abi: RollupAbi, data: data! });
      if (decoded.functionName !== 'submitEpochRootProof') {
        throw new Error(`Unexpected function ${decoded.functionName}`);
      }
      return decoded.args[0].attestations;
    };

    it('submits the tuple posted on L1 byte for byte, spare bitmap bits included', async () => {
      // A committee of 3 leaves five bitmap bits that map to no committee position. A proposer can set one of
      // them: neither L1 nor the node reads it, but it is inside the attestationsHash stored at propose time,
      // so an epoch proof that rebuilds the tuple from decoded attestations reverts forever.
      postedAttestations = makePackedAttestations(3, { spareBit: true });

      await publisher.submitEpochProof(setupPublishData(65, 32, 33, 64));

      expect(submittedAttestations()).toEqual(postedAttestations);
      expect(computeAttestationsHash(submittedAttestations())).toEqual(
        (await rollup.getCheckpoint(CheckpointNumber(64))).attestationsHash.toString(),
      );
    });

    it('reads the tuple of the last checkpoint in the range', async () => {
      await publisher.submitEpochProof(setupPublishData(65, 32, 33, 64));

      expect(verbatimAttestations.getVerbatimAttestations).toHaveBeenCalledWith(CheckpointNumber(64));
    });

    it('fails the submission when the posted tuple cannot be recovered', async () => {
      verbatimAttestations.getVerbatimAttestations.mockRejectedValue(new Error('pruned logs'));

      await expect(publisher.submitEpochProof(setupPublishData(65, 32, 33, 64))).rejects.toThrow('pruned logs');
      expect(l1Utils.sendAndMonitorTransaction).not.toHaveBeenCalled();
    });

    it('refuses to send a tuple that does not hash to the stored attestations hash', async () => {
      const args = setupPublishData(65, 32, 33, 64);
      // Recovered after the on-chain hash was mocked, so the two disagree.
      postedAttestations = makePackedAttestations(3, { spareBit: true });

      await expect(publisher.submitEpochProof(args)).rejects.toThrow('Attestations hash mismatch for checkpoint 64');
      expect(l1Utils.sendAndMonitorTransaction).not.toHaveBeenCalled();
    });
  });

  describe('compact checkpoint headers', () => {
    it.each([
      { proven: 32, end: 48, prefixLength: 0 },
      { proven: 40, end: 48, prefixLength: 8 },
      { proven: 48, end: 48, prefixLength: 16 },
    ])('encodes $prefixLength compact entries when proven is $proven', async ({ proven, end, prefixLength }) => {
      const args = setupPublishData(64, proven, 33, end);
      await publisher.submitEpochProof(args);
      const [{ data }] = l1Utils.sendAndMonitorTransaction.mock.calls[0];
      const decoded = decodeFunctionData({ abi: RollupAbi, data: data! });
      if (decoded.functionName !== 'submitEpochRootProof') {
        throw new Error(`Unexpected function ${decoded.functionName}`);
      }
      const [submission] = decoded.args;
      const fullHeaders = args.headers.map(header => header.toViem());
      const headers = fullHeaders.map(header => ({ ...header, coinbase: getAddress(header.coinbase) }));
      expect(submission.provenCheckpointFees).toEqual(
        headers.slice(0, prefixLength).map(({ coinbase, accumulatedFees }) => ({ coinbase, accumulatedFees })),
      );
      expect(submission.headers).toEqual(headers.slice(prefixLength));
      expect(rollup.getEpochProofPublicInputs.mock.calls[0][0][3]).toEqual(fullHeaders);
    });
  });

  describe('proof submission target', () => {
    it('defaults the submit tx target to the rollup address', async () => {
      const rollupAddress = EthAddress.random().toString();
      (rollup as any).address = rollupAddress;
      publisher = new ProverNodePublisher(config, {
        rollupContract: rollup,
        l1TxUtils: l1Utils,
        verbatimAttestations,
      });

      await publisher.submitEpochProof(setupPublishData(65, 32, 33, 64));
      expect(l1Utils.sendAndMonitorTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ to: rollupAddress }),
        expect.anything(),
      );
    });

    it('redirects the submit tx to the configured proof submission target', async () => {
      (rollup as any).address = EthAddress.random().toString();
      const target = EthAddress.random();
      publisher = new ProverNodePublisher(config, {
        rollupContract: rollup,
        l1TxUtils: l1Utils,
        verbatimAttestations,
        proofSubmissionTarget: target,
      });

      await publisher.submitEpochProof(setupPublishData(65, 32, 33, 64));
      expect(l1Utils.sendAndMonitorTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ to: target.toString() }),
        expect.anything(),
      );
    });
  });

  it.each([32, 40, 64])('estimates compact calldata without sending when proven is %i', async proven => {
    const fromCheckpoint = 33;
    const toCheckpoint = 64;

    rollup.getTips.mockResolvedValue({ pending: CheckpointNumber(65), proven: CheckpointNumber(proven) });

    const checkpoints = Array.from({ length: 100 }, () => RootRollupPublicInputs.random());
    rollup.getCheckpoint.mockImplementation((n: CheckpointNumber) =>
      Promise.resolve({
        archive: checkpoints[n - 1].endArchiveRoot,
        attestationsHash: Buffer32.fromString(computeAttestationsHash(postedAttestations)),
        payloadDigest: Buffer32.ZERO,
        headerHash: Buffer32.ZERO,
        blobCommitmentsHash: Buffer32.ZERO,
        outHash: '0x',
        slotNumber: SlotNumber(0),
        feeHeader: { excessMana: 0n, manaUsed: 0n, ethPerFeeAsset: 0n, protocolFee: 0n, proverCost: 0n },
      }),
    );

    const ourPublicInputs = RootRollupPublicInputs.random();
    ourPublicInputs.previousArchiveRoot = checkpoints[fromCheckpoint - 2].endArchiveRoot;
    ourPublicInputs.endArchiveRoot = checkpoints[toCheckpoint - 1].endArchiveRoot;
    rollup.getEpochProofPublicInputs.mockResolvedValue([...ourPublicInputs.toFields()]);

    jest.spyOn(l1Utils, 'getSenderAddress').mockReturnValue(EthAddress.random());
    jest.spyOn(l1Utils, 'estimateGas').mockResolvedValue(500_000n);
    jest
      .spyOn(l1Utils, 'getFeesPerGas')
      .mockResolvedValue({ maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    (l1Utils as any).client = {
      getBlock: jest
        .fn<() => Promise<{ baseFeePerGas: bigint }>>()
        .mockResolvedValue({ baseFeePerGas: 10_000_000_000n }),
    };

    const batchedBlob = new BatchedBlob(
      ourPublicInputs.blobPublicInputs.blobCommitmentsHash,
      ourPublicInputs.blobPublicInputs.z,
      ourPublicInputs.blobPublicInputs.y,
      ourPublicInputs.blobPublicInputs.c,
      ourPublicInputs.blobPublicInputs.c.negate(),
    );

    const headers = makeHeadersForRange(fromCheckpoint, toCheckpoint);
    await publisher.analyzeEpochProofSubmission({
      epochNumber: EpochNumber(2),
      kind: 'full',
      fromCheckpoint: CheckpointNumber(fromCheckpoint),
      toCheckpoint: CheckpointNumber(toCheckpoint),
      publicInputs: ourPublicInputs,
      headers,
      proof: Proof.empty(),
      batchedBlobInputs: batchedBlob,
    });

    const [, { data }] = l1Utils.estimateGas.mock.calls[0];
    const decoded = decodeFunctionData({ abi: RollupAbi, data: data! });
    if (decoded.functionName !== 'submitEpochRootProof') {
      throw new Error(`Unexpected function ${decoded.functionName}`);
    }
    const [submission] = decoded.args;
    const prefixLength = proven - fromCheckpoint + 1;
    const expectedHeaders = headers.map(header => {
      const viem = header.toViem();
      return { ...viem, coinbase: getAddress(viem.coinbase) };
    });
    expect(submission.provenCheckpointFees).toEqual(
      expectedHeaders.slice(0, prefixLength).map(({ coinbase, accumulatedFees }) => ({ coinbase, accumulatedFees })),
    );
    expect(submission.headers).toEqual(expectedHeaders.slice(prefixLength));
    expect(l1Utils.getFeesPerGas).toHaveBeenCalled();
    expect(l1Utils.sendAndMonitorTransaction).not.toHaveBeenCalled();
  });

  it('handles reverted txs correctly', async () => {
    const checkpoints = [RootRollupPublicInputs.random(), RootRollupPublicInputs.random()];

    // Return the tips specified by the test
    rollup.getTips.mockResolvedValue({
      pending: CheckpointNumber(2),
      proven: CheckpointNumber(1),
    });

    // Return the requested checkpoint
    rollup.getCheckpoint.mockImplementation((checkpointNumber: CheckpointNumber) =>
      Promise.resolve({
        archive: checkpoints[checkpointNumber - 1].endArchiveRoot,
        attestationsHash: Buffer32.fromString(computeAttestationsHash(postedAttestations)),
        payloadDigest: Buffer32.ZERO, // unused,
        headerHash: Buffer32.ZERO, // unused,
        blobCommitmentsHash: Buffer32.ZERO, // unused,
        outHash: '0x', // unused,
        slotNumber: SlotNumber(0), // unused,
        feeHeader: {
          excessMana: 0n, // unused
          manaUsed: 0n, // unused
          ethPerFeeAsset: 0n, // unused
          protocolFee: 0n, // unused
          proverCost: 0n, // unused
        },
      }),
    );

    // We have built a rollup proof of the range fromCheckpoint - toCheckpoint
    // so we need to set our archives and hashes accordingly
    const ourPublicInputs = RootRollupPublicInputs.random();
    ourPublicInputs.previousArchiveRoot = checkpoints[0].endArchiveRoot ?? Fr.ZERO;
    ourPublicInputs.endArchiveRoot = checkpoints[1].endArchiveRoot ?? Fr.ZERO;

    const ourBatchedBlob = new BatchedBlob(
      ourPublicInputs.blobPublicInputs.blobCommitmentsHash,
      ourPublicInputs.blobPublicInputs.z,
      ourPublicInputs.blobPublicInputs.y,
      ourPublicInputs.blobPublicInputs.c,
      ourPublicInputs.blobPublicInputs.c.negate(), // Fill with dummy value
    );

    // Return our public inputs
    const totalFields = ourPublicInputs.toFields();
    rollup.getEpochProofPublicInputs.mockResolvedValue(totalFields);

    jest.spyOn(l1Utils, 'getSenderBalance').mockResolvedValue(42n);
    jest.spyOn(l1Utils, 'getSenderAddress').mockReturnValue(EthAddress.random());

    jest.spyOn(l1Utils, 'sendAndMonitorTransaction').mockResolvedValue({
      state: { feesPerGas: {} as any } as any,
      receipt: {
        status: 'reverted',
        effectiveGasPrice: 1n,
        gasUsed: 1n,
        transactionHash: `0x${randomBytes(32).toString('hex')}`,
        cumulativeGasUsed: 1n,
        blockNumber: 42n,
        blockHash: `0x${randomBytes(32).toString('hex')}`,
        from: EthAddress.random().toString(),
      } as any,
    });

    jest.spyOn(l1Utils, 'getTransactionStats').mockResolvedValue({
      calldataGas: 1,
      calldataSize: 1,
      sender: EthAddress.random().toString(),
      transactionHash: `0x${randomBytes(32).toString('hex')}`,
    });

    const result = await publisher.submitEpochProof({
      epochNumber: EpochNumber(2),
      kind: 'full',
      fromCheckpoint: CheckpointNumber(2),
      toCheckpoint: CheckpointNumber(2),
      publicInputs: ourPublicInputs,
      headers: makeHeadersForRange(2, 2),
      proof: Proof.empty(),
      batchedBlobInputs: ourBatchedBlob,
    });

    expect(result).toBe('failed');
  });
});
