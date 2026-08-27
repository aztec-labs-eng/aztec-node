import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { ExecutionNoteCache } from '@aztec-labs/pxe/simulator';
import { computeNoteHashNonce, computeUniqueNoteHash, siloNoteHash } from '@aztec-labs/stdlib/hash';
import { TxEffect, TxHash } from '@aztec-labs/stdlib/tx';

export async function makeTxEffect(noteCache: ExecutionNoteCache, txBlockNumber: BlockNumber): Promise<TxEffect> {
  const txEffect = TxEffect.empty();

  const nonceGenerator = noteCache.getNonceGenerator();
  txEffect.noteHashes = await Promise.all(
    noteCache
      .getAllNotes()
      .map(async (pendingNote, i) =>
        computeUniqueNoteHash(
          await computeNoteHashNonce(nonceGenerator, i),
          await siloNoteHash(pendingNote.note.contractAddress, pendingNote.noteHashForConsumption),
        ),
      ),
  );

  // Nullifiers are already siloed
  txEffect.nullifiers = noteCache.getAllNullifiers();

  txEffect.txHash = new TxHash(new Fr(txBlockNumber));

  return txEffect;
}
