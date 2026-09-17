import { RollupAbi } from '@aztec-foundation/l1-artifacts';

import { CalldataRetriever } from '@aztec-labs/archiver';
import { BatchedBlob } from '@aztec-labs/blob-lib/types';
import {
  type CheckpointProposedLog,
  type RollupContract,
  type ViemCommitteeAttestations,
  computeAttestationsHash,
} from '@aztec-labs/ethereum/contracts';
import { randomL1ContractAddresses } from '@aztec-labs/ethereum/l1-contract-addresses';
import type { L1TxUtils } from '@aztec-labs/ethereum/l1-tx-utils';
import type { ViemPublicClient, ViemPublicDebugClient } from '@aztec-labs/ethereum/types';
import { CheckpointNumber, EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { SecretValue } from '@aztec-labs/foundation/config';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { createLogger } from '@aztec-labs/foundation/log';
import { bufferToHex } from '@aztec-labs/foundation/string';
import type { PublisherConfig, TxSenderConfig } from '@aztec-labs/sequencer-client';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import { CommitteeAttestation, CommitteeAttestationsAndSigners } from '@aztec-labs/stdlib/block';
import {
  Checkpoint,
  L1PublishedData,
  type PublishedCheckpoint,
  computeCheckpointPayloadDigest,
} from '@aztec-labs/stdlib/checkpoint';
import { Proof } from '@aztec-labs/stdlib/proofs';
import { CheckpointHeader, RootRollupPublicInputs } from '@aztec-labs/stdlib/rollup';
import { type MockProxy, mock } from 'jest-mock-extended';
import { type Transaction, decodeFunctionData, encodeFunctionData, toHex } from 'viem';

import { ProverNodePublisher } from './prover-node-publisher.js';
import { L1VerbatimAttestationsSource } from './verbatim-attestations.js';

/**
 * Drives the whole submission path with a real `CalldataRetriever` behind it: an L1 `propose` calldata carrying
 * a spare bitmap bit goes in, and the bytes are compared against the `submitEpochRootProof` calldata that comes
 * out. Only the L1 RPC boundary (the propose tx, the event log, the checkpoint reads) and the tx sender are
 * mocked; every decode, verification and re-encode step in between is the production one.
 */
describe('verbatim attestations over the real calldata retriever', () => {
  const chainId = 1;
  const committeeSize = 3;
  const fromCheckpoint = CheckpointNumber(33);
  const toCheckpoint = CheckpointNumber(64);
  const l1BlockNumber = 4242n;
  const l1TransactionHash = Buffer32.random().toString();
  const rollupAddress = EthAddress.random();

  let rollup: MockProxy<RollupContract>;
  let l1Utils: MockProxy<L1TxUtils>;
  let publisher: ProverNodePublisher;
  /** The exact tuple the propose calldata carries, spare bit and all. */
  let posted: ViemCommitteeAttestations;
  let publicInputs: RootRollupPublicInputs;

  /** Packs a committee of address-only attestations, then sets a bitmap bit past the last committee position. */
  const packWithSpareBit = (): ViemCommitteeAttestations => {
    const attestations = Array.from({ length: committeeSize }, () =>
      CommitteeAttestation.fromAddress(EthAddress.random()),
    );
    const packed = CommitteeAttestationsAndSigners.packAttestations(attestations);
    const bitmap = Buffer.from(packed.signatureIndices.slice(2), 'hex');
    bitmap[bitmap.length - 1] |= 1;
    return { ...packed, signatureIndices: bufferToHex(bitmap) };
  };

  const encodeProposeCalldata = (checkpoint: Checkpoint, attestations: ViemCommitteeAttestations) =>
    encodeFunctionData({
      abi: RollupAbi,
      functionName: 'propose',
      args: [
        {
          header: checkpoint.header.toViem(),
          archive: toHex(checkpoint.archive.root.toBuffer()),
          oracleInput: { feeAssetPriceModifier: 0n },
          bucketHint: 0n,
        },
        attestations,
        [],
        Signature.random().toViemSignature(),
        '0x',
      ],
    });

  beforeEach(async () => {
    const checkpoint = await Checkpoint.random(toCheckpoint, { numBlocks: 1 });
    posted = packWithSpareBit();

    const attestationsHash = Buffer32.fromString(computeAttestationsHash(posted));
    const payloadDigest = computeCheckpointPayloadDigest({
      header: checkpoint.header,
      archiveRoot: checkpoint.archive.root,
      feeAssetPriceModifier: 0n,
      signatureContext: { chainId, rollupAddress },
    });

    // The L1 RPC boundary: the propose tx as it sits on chain, and the event pointing at it.
    const proposeTx = {
      input: encodeProposeCalldata(checkpoint, posted),
      to: rollupAddress.toString(),
      hash: l1TransactionHash,
      blockHash: Buffer32.random().toString(),
    } as Transaction;
    const publicClient = mock<ViemPublicClient>();
    publicClient.getTransaction.mockResolvedValue(proposeTx);
    (publicClient as { chain: { id: number } }).chain = { id: chainId };

    rollup = mock<RollupContract>();
    (rollup as { address: string }).address = rollupAddress.toString();
    rollup.getHasSubmittedProof.mockResolvedValue(false);
    rollup.getTips.mockResolvedValue({ pending: CheckpointNumber(65), proven: CheckpointNumber(32) });
    rollup.getCheckpointProposedEvents.mockResolvedValue([
      {
        l1BlockNumber,
        l1BlockHash: Buffer32.random(),
        l1TransactionHash,
        args: {
          checkpointNumber: toCheckpoint,
          archive: checkpoint.archive.root,
          versionedBlobHashes: [],
          attestationsHash,
          payloadDigest,
        },
      } satisfies CheckpointProposedLog,
    ]);

    // Archive roots the publisher reconciles the proof against, plus the hashes the source verifies with.
    const previousArchive = Fr.random();
    publicInputs = RootRollupPublicInputs.random();
    publicInputs.previousArchiveRoot = previousArchive;
    publicInputs.endArchiveRoot = checkpoint.archive.root;
    rollup.getCheckpoint.mockImplementation((n: CheckpointNumber) =>
      Promise.resolve({
        archive: n === toCheckpoint ? checkpoint.archive.root : previousArchive,
        attestationsHash,
        payloadDigest,
        headerHash: Buffer32.ZERO,
        blobCommitmentsHash: Buffer32.ZERO,
        slotNumber: SlotNumber(0),
        feeHeader: { excessMana: 0n, manaUsed: 0n, ethPerFeeAsset: 0n, protocolFee: 0n, proverCost: 0n },
      }),
    );
    rollup.getEpochProofPublicInputs.mockResolvedValue([...publicInputs.toFields()]);

    const l2BlockSource = mock<Pick<L2BlockSource, 'getCheckpoint'>>();
    l2BlockSource.getCheckpoint.mockResolvedValue({
      l1: new L1PublishedData(l1BlockNumber, 0n, Buffer32.random().toString()),
    } as PublishedCheckpoint);

    const verbatimAttestations = new L1VerbatimAttestationsSource({
      l2BlockSource,
      rollupContract: rollup,
      calldataRetriever: new CalldataRetriever(
        publicClient,
        mock<ViemPublicDebugClient>(),
        committeeSize,
        undefined,
        createLogger('test:calldata-retriever'),
        rollupAddress,
      ),
    });

    l1Utils = mock<L1TxUtils>();
    const config: TxSenderConfig & PublisherConfig = {
      l1ChainId: chainId,
      l1RpcUrls: ['http://localhost:8545'],
      l1DebugRpcUrls: [],
      publisherPrivateKeys: [new SecretValue('0x1234')],
      viemPollingIntervalMS: 1000,
      ...randomL1ContractAddresses(),
    };
    publisher = new ProverNodePublisher(config, { rollupContract: rollup, l1TxUtils: l1Utils, verbatimAttestations });
  });

  it('carries the posted tuple from the propose calldata into the submitEpochRootProof calldata', async () => {
    const batchedBlobInputs = new BatchedBlob(
      publicInputs.blobPublicInputs.blobCommitmentsHash,
      publicInputs.blobPublicInputs.z,
      publicInputs.blobPublicInputs.y,
      publicInputs.blobPublicInputs.c,
      publicInputs.blobPublicInputs.c.negate(),
    );

    await publisher.submitEpochProof({
      epochNumber: EpochNumber(2),
      kind: 'full',
      fromCheckpoint,
      toCheckpoint,
      publicInputs,
      headers: Array.from({ length: toCheckpoint - fromCheckpoint + 1 }, () => CheckpointHeader.random()),
      proof: Proof.empty(),
      batchedBlobInputs,
      // Bounds the retrieval retry, so a regression fails the test promptly instead of burning the full budget.
      deadline: new Date(Date.now() + 1000),
    });

    const [{ data }] = l1Utils.sendAndMonitorTransaction.mock.calls[0];
    const decoded = decodeFunctionData({ abi: RollupAbi, data: data! });
    if (decoded.functionName !== 'submitEpochRootProof') {
      throw new Error(`Unexpected function ${decoded.functionName}`);
    }

    const submitted = decoded.args[0].attestations;
    expect(submitted).toEqual(posted);
    expect(Buffer32.fromString(computeAttestationsHash(submitted))).toEqual(
      (await rollup.getCheckpoint(toCheckpoint)).attestationsHash,
    );
  });
});
