import { createL1TxFailedStore } from './factory.js';
import type { FailedL1Tx } from './failed_tx_store.js';

describe('createL1TxFailedStore', () => {
  it('disables the optional store when initialization fails', async () => {
    await expect(createL1TxFailedStore('unsupported://failed-l1-txs')).resolves.toBeUndefined();
  });

  it('returns undefined when no store is configured', async () => {
    await expect(createL1TxFailedStore(undefined)).resolves.toBeUndefined();
  });

  it('stores and retrieves failed transactions when initialization succeeds', async () => {
    const store = await createL1TxFailedStore('mem://failed-l1-tx-factory-test');
    expect(store).toBeDefined();
    const tx: FailedL1Tx = {
      id: '0x1234',
      timestamp: 123,
      failureType: 'send-error',
      request: { to: '0x1234', data: '0x' },
      l1BlockNumber: 1n,
      error: { message: 'Transaction failed' },
      context: { actions: ['propose'], sender: '0x5678' },
    };
    const uri = await store!.saveFailedTx(tx);
    await expect(store!.getFailedTx(uri)).resolves.toEqual(tx);
  });
});
