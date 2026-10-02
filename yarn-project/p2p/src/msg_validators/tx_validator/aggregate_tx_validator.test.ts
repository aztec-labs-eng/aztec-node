import { mockTx } from '@aztec-labs/stdlib/testing';
import type { AnyTx, TxHash, TxValidationResult, TxValidator } from '@aztec-labs/stdlib/tx';

import { AggregateTxValidator } from './aggregate_tx_validator.js';

describe('AggregateTxValidator', () => {
  it('stops validation at the first failure', async () => {
    const txs = await Promise.all([mockTx(0), mockTx(1), mockTx(2), mockTx(3), mockTx(4)]);
    const agg = new AggregateTxValidator(
      new TxDenyList([txs[0].getTxHash(), txs[1].getTxHash(), txs[4].getTxHash()]),
      new TxDenyList([txs[2].getTxHash(), txs[4].getTxHash()]),
    );

    await expect(agg.validateTx(txs[0])).resolves.toEqual({ result: 'invalid', reason: ['Denied'] });
    await expect(agg.validateTx(txs[1])).resolves.toEqual({ result: 'invalid', reason: ['Denied'] });
    await expect(agg.validateTx(txs[2])).resolves.toEqual({ result: 'invalid', reason: ['Denied'] });
    await expect(agg.validateTx(txs[3])).resolves.toEqual({ result: 'valid' });
    await expect(agg.validateTx(txs[4])).resolves.toEqual({ result: 'invalid', reason: ['Denied'] });
  });

  it('does not run validators after the first failure', async () => {
    const tx = await mockTx(0);
    const agg = new AggregateTxValidator(
      new TxDenyList([tx.getTxHash()]),
      new (class implements TxValidator<AnyTx> {
        validateTx(): Promise<TxValidationResult> {
          throw new Error('Validator after first failure was run');
        }
      })(),
    );

    await expect(agg.validateTx(tx)).resolves.toEqual({ result: 'invalid', reason: ['Denied'] });
  });

  it('reports a later invalid check rather than an earlier unverifiable one', async () => {
    const tx = await mockTx(0);
    const agg = new AggregateTxValidator(
      new TxDenyList([]),
      { validateTx: () => Promise.resolve<TxValidationResult>({ result: 'unverifiable', reason: ['down'] }) },
      new TxDenyList([tx.getTxHash()]),
    );

    await expect(agg.validateTx(tx)).resolves.toEqual({ result: 'invalid', reason: ['Denied'] });
  });

  it('reports an earlier invalid check rather than a later unverifiable one', async () => {
    const tx = await mockTx(0);
    const agg = new AggregateTxValidator(new TxDenyList([tx.getTxHash()]), {
      validateTx: () => Promise.resolve<TxValidationResult>({ result: 'unverifiable', reason: ['down'] }),
    });

    await expect(agg.validateTx(tx)).resolves.toEqual({ result: 'invalid', reason: ['Denied'] });
  });

  it('reports the first unverifiable check when no check finds the tx invalid', async () => {
    const tx = await mockTx(0);
    const first: TxValidationResult = { result: 'unverifiable', reason: ['first'] };
    const second: TxValidationResult = { result: 'unverifiable', reason: ['second'] };
    const agg = new AggregateTxValidator({ validateTx: () => Promise.resolve(first) }, new TxDenyList([]), {
      validateTx: () => Promise.resolve(second),
    });

    await expect(agg.validateTx(tx)).resolves.toEqual(first);
  });

  class TxDenyList implements TxValidator<AnyTx> {
    denyList: Set<string>;

    constructor(deniedTxHashes: TxHash[]) {
      this.denyList = new Set(deniedTxHashes.map(hash => hash.toString()));
    }

    validateTx(tx: AnyTx): Promise<TxValidationResult> {
      const txHash = 'txHash' in tx ? tx.txHash : tx.hash;
      if (this.denyList.has(txHash.toString())) {
        return Promise.resolve({ result: 'invalid', reason: ['Denied'] });
      }
      return Promise.resolve({ result: 'valid' });
    }
  }
});
