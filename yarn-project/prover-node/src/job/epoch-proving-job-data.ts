import type { ViemCommitteeAttestations } from '@aztec-labs/ethereum/contracts';
import { CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { BufferReader, serializeToBuffer } from '@aztec-labs/foundation/serialize';
import { bufferToHex, hexToBuffer } from '@aztec-labs/foundation/string';
import { Checkpoint } from '@aztec-labs/stdlib/checkpoint';
import { BlockHeader, Tx } from '@aztec-labs/stdlib/tx';

/** All data from an epoch used in proving. */
export type EpochProvingJobData = {
  epochNumber: EpochNumber;
  checkpoints: Checkpoint[];
  txs: Map<string, Tx>;
  l1ToL2Messages: Record<CheckpointNumber, Fr[]>;
  previousBlockHeader: BlockHeader;
  /** Inbox rolling hash of the checkpoint before the epoch's first checkpoint (its chain start); genesis is zero. */
  previousInboxRollingHash: Fr;
  /** The packed attestations tuple of the epoch's last checkpoint, as posted to L1. */
  verbatimAttestations: ViemCommitteeAttestations;
};

export function validateEpochProvingJobData(data: EpochProvingJobData) {
  if (data.checkpoints.length === 0) {
    throw new Error('No checkpoints to prove');
  }

  const firstBlockNumber = data.checkpoints[0].blocks[0].number;
  const previousBlockNumber = data.previousBlockHeader.getBlockNumber();
  if (previousBlockNumber + 1 !== firstBlockNumber) {
    throw new Error(
      `Initial block number ${firstBlockNumber} does not match previous block header ${previousBlockNumber}`,
    );
  }

  for (const checkpoint of data.checkpoints) {
    if (!(checkpoint.number in data.l1ToL2Messages)) {
      throw new Error(`Missing L1 to L2 messages for checkpoint number ${checkpoint.number}`);
    }
  }
}

export function serializeEpochProvingJobData(data: EpochProvingJobData): Buffer {
  const checkpoints = data.checkpoints.map(checkpoint => checkpoint.toBuffer());
  const txs = Array.from(data.txs.values()).map(tx => tx.toBuffer());
  const l1ToL2Messages = Object.entries(data.l1ToL2Messages).map(([checkpointNumber, messages]) => [
    Number(checkpointNumber),
    messages.length,
    ...messages,
  ]);
  const signatureIndices = hexToBuffer(data.verbatimAttestations.signatureIndices);
  const signaturesOrAddresses = hexToBuffer(data.verbatimAttestations.signaturesOrAddresses);

  return serializeToBuffer(
    data.epochNumber,
    data.previousBlockHeader,
    data.previousInboxRollingHash,
    checkpoints.length,
    ...checkpoints,
    txs.length,
    ...txs,
    l1ToL2Messages.length,
    ...l1ToL2Messages,
    signatureIndices.length,
    signatureIndices,
    signaturesOrAddresses.length,
    signaturesOrAddresses,
  );
}

export function deserializeEpochProvingJobData(buf: Buffer): EpochProvingJobData {
  const reader = BufferReader.asReader(buf);
  const epochNumber = EpochNumber(reader.readNumber());
  const previousBlockHeader = reader.readObject(BlockHeader);
  const previousInboxRollingHash = Fr.fromBuffer(reader);
  const checkpoints = reader.readVector(Checkpoint);
  const txArray = reader.readVector(Tx);

  const l1ToL2MessageCheckpointCount = reader.readNumber();
  const l1ToL2Messages: Record<number, Fr[]> = {};
  for (let i = 0; i < l1ToL2MessageCheckpointCount; i++) {
    const checkpointNumber = CheckpointNumber(reader.readNumber());
    const messages = reader.readVector(Fr);
    l1ToL2Messages[checkpointNumber] = messages;
  }

  const verbatimAttestations: ViemCommitteeAttestations = {
    signatureIndices: bufferToHex(reader.readBuffer()),
    signaturesOrAddresses: bufferToHex(reader.readBuffer()),
  };

  const txs = new Map<string, Tx>(txArray.map(tx => [tx.getTxHash().toString(), tx]));

  return {
    epochNumber,
    previousBlockHeader,
    previousInboxRollingHash,
    checkpoints,
    txs,
    l1ToL2Messages,
    verbatimAttestations,
  };
}
