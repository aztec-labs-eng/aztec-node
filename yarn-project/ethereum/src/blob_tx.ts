import {
  type ByteArray,
  type Hex,
  type TransactionSerializable,
  type TransactionSerializableEIP4844,
  blobsToCommitments,
  bytesToHex,
  concatHex,
  fromRlp,
  hexToBytes,
  parseTransaction,
  serializeTransaction,
  toRlp,
} from 'viem';

/**
 * Chains whose execution layer runs Fusaka, which only accepts blob txs in the EIP-7594 network wrapper
 * (wrapper version 1, with cell proofs). Other chains (e.g. anvil) keep the EIP-4844 wrapper.
 */
const EIP7594_CHAIN_IDS = new Set([
  1, // mainnet
  11_155_111, // sepolia
  560_048, // hoodi
]);

/** Number of cell proofs per blob in an EIP-7594 network wrapper. */
const CELLS_PER_EXT_BLOB = 128;

type KzgWithCellProofs = {
  blobToKzgCommitment(blob: ByteArray): ByteArray;
  computeCellsAndKzgProofs(blob: ByteArray): [ByteArray[], ByteArray[]];
};

type TransactionSignature = Parameters<typeof serializeTransaction>[1];

/** Returns whether blob txs sent to the given chain must use the EIP-7594 network wrapper. */
export function usesEip7594BlobWrapper(chainId: number | undefined): boolean {
  return chainId !== undefined && EIP7594_CHAIN_IDS.has(chainId);
}

/**
 * Serializes a signed tx for broadcasting. Behaves like viem's `serializeTransaction`, except that blob txs
 * for chains that require it are wrapped in the EIP-7594 network wrapper, which viem v2 does not support:
 * `0x03 || rlp([tx_payload_body, wrapper_version, blobs, commitments, cell_proofs])`.
 */
export function serializeSignedTransaction(tx: TransactionSerializable, signature: TransactionSignature): Hex {
  if (tx.type !== 'eip4844' || !tx.blobs || !usesEip7594BlobWrapper(tx.chainId)) {
    return serializeTransaction(tx, signature);
  }

  const kzg = tx.kzg as Partial<KzgWithCellProofs> | undefined;
  if (!kzg?.blobToKzgCommitment || !kzg.computeCellsAndKzgProofs) {
    throw new Error('Serializing an EIP-7594 blob tx requires a kzg instance with computeCellsAndKzgProofs');
  }

  const envelope = serializeTransaction({ ...tx, sidecars: false } as TransactionSerializableEIP4844, signature);
  const payloadBody = fromRlp(`0x${envelope.slice(4)}`, 'hex');

  const blobs = tx.blobs.map(blob => (typeof blob === 'string' ? blob : bytesToHex(blob)));
  const commitments = blobsToCommitments({ blobs, kzg: kzg as KzgWithCellProofs, to: 'hex' });
  const cellProofs = blobs.flatMap(blob => {
    const [, proofs] = kzg.computeCellsAndKzgProofs!(hexToBytes(blob));
    if (proofs.length !== CELLS_PER_EXT_BLOB) {
      throw new Error(`Expected ${CELLS_PER_EXT_BLOB} cell proofs per blob but got ${proofs.length}`);
    }
    return proofs.map(proof => bytesToHex(proof));
  });

  return concatHex(['0x03', toRlp([payloadBody, '0x01', blobs, commitments, cellProofs])]);
}

/**
 * Parses a signed serialized tx like viem's `parseTransaction`, also accepting blob txs in the EIP-7594 network
 * wrapper. The network wrapper of such txs is dropped, so the result carries no blobs or sidecars.
 */
export function parseSignedTransaction(serializedTransaction: Hex) {
  return parseTransaction(stripEip7594BlobWrapper(serializedTransaction));
}

function stripEip7594BlobWrapper(serializedTransaction: Hex): Hex {
  if (!serializedTransaction.startsWith('0x03')) {
    return serializedTransaction;
  }
  const decoded = fromRlp(`0x${serializedTransaction.slice(4)}`, 'hex');
  if (Array.isArray(decoded) && decoded.length === 5 && Array.isArray(decoded[0]) && decoded[1] === '0x01') {
    return concatHex(['0x03', toRlp(decoded[0])]);
  }
  return serializedTransaction;
}
