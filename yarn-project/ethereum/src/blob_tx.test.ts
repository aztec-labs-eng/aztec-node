import { Blob, getKzg } from '@aztec-labs/blob-lib';
import {
  type Hex,
  type TransactionSerializableEIP4844,
  blobsToCommitments,
  commitmentsToVersionedHashes,
  fromRlp,
  hexToBytes,
  keccak256,
  parseTransaction,
  serializeTransaction,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';

import {
  computeSignedTransactionHash,
  parseSignedTransaction,
  recoverSignedTransactionAddress,
  serializeSignedTransaction,
} from './blob_tx.js';
import sepoliaBlobTx from './test/fixtures/sepolia_blob_tx.json' with { type: 'json' };

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

  it('wraps blob txs without an explicit type in the EIP-7594 network wrapper on sepolia', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { type, ...untyped } = makeTx(11_155_111);
    const serialized = serializeSignedTransaction(untyped, signature);
    expect(serialized).toEqual(serializeSignedTransaction(makeTx(11_155_111), signature));
  });

  it.each([31337, 11_155_111])('hashes signed blob txs without their network wrapper on chain %i', chainId => {
    const tx = makeTx(chainId);
    const envelope = serializeTransaction({ ...tx, sidecars: false }, signature);
    expect(computeSignedTransactionHash(serializeSignedTransaction(tx, signature))).toEqual(keccak256(envelope));
  });

  it.each([31337, 11_155_111])('recovers the sender of signed blob txs on chain %i', async chainId => {
    const privateKey = generatePrivateKey();
    const tx = makeTx(chainId);
    const txSignature = await sign({
      hash: keccak256(serializeTransaction({ ...tx, sidecars: false })),
      privateKey,
    });
    const serialized = serializeSignedTransaction(tx, txSignature);
    expect(await recoverSignedTransactionAddress(serialized)).toEqual(privateKeyToAccount(privateKey).address);
  });

  describe('with a blob tx mined on sepolia', () => {
    const {
      hash,
      rawTransaction,
      blobs: fixtureBlobs,
      blobVersionedHashes,
    } = sepoliaBlobTx as {
      hash: Hex;
      rawTransaction: Hex;
      blobs: Hex[];
      blobVersionedHashes: Hex[];
    };
    const { r, s, yParity, ...unsigned } = parseTransaction(rawTransaction) as TransactionSerializableEIP4844;
    const minedSignature = { r: r!, s: s!, yParity: yParity! };
    const minedTx = { ...unsigned, blobs: fixtureBlobs, kzg };

    it('matches the blob in the fixture to the mined tx', () => {
      const commitments = blobsToCommitments({ blobs: fixtureBlobs, kzg });
      expect(commitmentsToVersionedHashes({ commitments })).toEqual(blobVersionedHashes);
    });

    it('hashes the mined tx without a network wrapper', () => {
      expect(computeSignedTransactionHash(rawTransaction)).toEqual(hash);
    });

    it('hashes the mined tx in the EIP-7594 network wrapper', () => {
      const serialized = serializeSignedTransaction(minedTx, minedSignature);
      expect(fromRlp(`0x${serialized.slice(4)}`, 'hex')).toHaveLength(5);
      expect(computeSignedTransactionHash(serialized)).toEqual(hash);
    });

    it('hashes the mined tx in the EIP-4844 network wrapper', () => {
      const serialized = serializeTransaction(minedTx, minedSignature);
      expect(fromRlp(`0x${serialized.slice(4)}`, 'hex')).toHaveLength(4);
      expect(computeSignedTransactionHash(serialized)).toEqual(hash);
    });
  });
});
