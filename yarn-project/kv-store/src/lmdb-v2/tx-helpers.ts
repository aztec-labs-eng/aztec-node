import type { ReadTransaction } from './read_transaction.js';
import type { AztecLMDBStoreV2 } from './store.js';
import type { WriteTransaction } from './write_transaction.js';

/** Runs `fn` in the enclosing write transaction, or in a new one. Throws inside a read-only transaction. */
export function execInWriteTx<T>(store: AztecLMDBStoreV2, fn: (tx: WriteTransaction) => Promise<T>): Promise<T> {
  return store.transactionAsync(fn);
}

export async function execInReadTx<T>(
  store: AztecLMDBStoreV2,
  fn: (tx: ReadTransaction) => T | Promise<T>,
): Promise<T> {
  const currentTx = store.getCurrentTx();
  if (currentTx) {
    return await fn(currentTx);
  } else {
    const tx = store.getReadTx();
    try {
      return await fn(tx);
    } finally {
      tx.close();
    }
  }
}
