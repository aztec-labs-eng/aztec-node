import { Blob, getKzg } from '@aztec-labs/blob-lib';
import {
  type Hex,
  type TransactionSerializableEIP4844,
  fromRlp,
  hexToBytes,
  keccak256,
  parseTransaction,
  serializeTransaction,
} from 'viem';

import { parseSignedTransaction, serializeSignedTransaction } from './blob_tx.js';

describe('blob tx serialization', () => {
  const kzg = Blob.getViemKzgInstance();
  const signature = {
    r: '0x1111111111111111111111111111111111111111111111111111111111111111',
    s: '0x2222222222222222222222222222222222222222222222222222222222222222',
    yParity: 1,
  } as const;
  const blobs = [new Uint8Array(131072).fill(1), new Uint8Array(131072).fill(2)];

  const makeTx = (chainId: number) =>
    ({
      type: 'eip4844',
      chainId,
      nonce: 7,
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      gas: 100_000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      maxFeePerBlobGas: 3n,
      blobs,
      kzg,
    }) satisfies TransactionSerializableEIP4844;

  it('uses the EIP-4844 network wrapper on chains without EIP-7594', () => {
    const tx = makeTx(31337);
    const serialized = serializeSignedTransaction(tx, signature);
    expect(serialized).toEqual(serializeTransaction(tx, signature));
    expect(parseSignedTransaction(serialized).sidecars).toHaveLength(2);
  });

  it('uses the EIP-7594 network wrapper with verifiable cell proofs on sepolia', () => {
    const tx = makeTx(11_155_111);
    const serialized = serializeSignedTransaction(tx, signature);
    expect(serialized.startsWith('0x03')).toBe(true);

    const [payloadBody, wrapperVersion, wrappedBlobs, commitments, cellProofs] = fromRlp(
      `0x${serialized.slice(4)}`,
      'hex',
    ) as [Hex[], Hex, Hex[], Hex[], Hex[]];
    expect(wrapperVersion).toEqual('0x01');
    expect(wrappedBlobs.map(b => hexToBytes(b))).toEqual(blobs);
    expect(commitments).toHaveLength(2);
    expect(cellProofs).toHaveLength(2 * 128);

    const cellIndices = blobs.flatMap(() => Array.from({ length: 128 }, (_, i) => i));
    const cells = blobs.flatMap(blob => getKzg().computeCells(blob));
    const cellCommitments = commitments.flatMap(c => Array(128).fill(hexToBytes(c)));
    expect(
      getKzg().verifyCellKzgProofBatch(
        cellCommitments,
        cellIndices,
        cells,
        cellProofs.map(p => hexToBytes(p)),
      ),
    ).toBe(true);

    const envelope = serializeTransaction({ ...tx, sidecars: false }, signature);
    expect(payloadBody).toEqual(fromRlp(`0x${envelope.slice(4)}`, 'hex'));

    const parsed = parseSignedTransaction(serialized);
    expect(parsed).toEqual(parseTransaction(envelope));
    expect(keccak256(serializeTransaction(parsed as TransactionSerializableEIP4844))).toEqual(keccak256(envelope));
  });

  it('rejects EIP-7594 blob txs when the kzg instance cannot compute cell proofs', () => {
    const tx = {
      ...makeTx(1),
      kzg: { blobToKzgCommitment: kzg.blobToKzgCommitment, computeBlobKzgProof: kzg.computeBlobKzgProof },
    };
    expect(() => serializeSignedTransaction(tx, signature)).toThrow(/computeCellsAndKzgProofs/);
  });
});
