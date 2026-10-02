import { BlockNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { GasFees } from '@aztec-labs/stdlib/gas';
import { BlockHeader } from '@aztec-labs/stdlib/tx';
import { jest } from '@jest/globals';

import { type TxMetaData, stubTxMetaData } from '../tx_metadata.js';
import { InsufficientFeePerGasEvictionRule } from './insufficient_fee_per_gas_eviction_rule.js';
import type { EvictionContext, PoolOperations } from './interfaces.js';
import { EvictionEvent } from './interfaces.js';

describe('InsufficientFeePerGasEvictionRule', () => {
  let pool: PoolOperations;
  let rule: InsufficientFeePerGasEvictionRule;
  let deleteTxsMock: jest.MockedFunction<any>;

  const nextBlockMinFees = new GasFees(10, 20);

  const createPoolOps = (pendingTxs: TxMetaData[]): PoolOperations => {
    deleteTxsMock = jest.fn(() => Promise.resolve());
    return {
      getPendingTxs: () => pendingTxs,
      getPendingFeePayers: () => [...new Set(pendingTxs.map(t => t.feePayer))],
      getFeePayerPendingTxs: (feePayer: string) => pendingTxs.filter(t => t.feePayer === feePayer),
      getPendingTxCount: () => pendingTxs.length,
      getLowestPriorityPending: () => [],
      deleteTxs: deleteTxsMock as (txHashes: string[]) => Promise<void>,
    };
  };

  beforeEach(() => {
    pool = createPoolOps([]);
    rule = new InsufficientFeePerGasEvictionRule({ getNextBlockMinFees: () => Promise.resolve(nextBlockMinFees) });
  });

  describe('non-SLOT_PREPARED events', () => {
    it('returns empty result for TXS_ADDED event', async () => {
      const context: EvictionContext = {
        event: EvictionEvent.TXS_ADDED,
        newTxHashes: [],
        feePayers: [],
      };

      const result = await rule.evict(context, pool);

      expect(result).toEqual({
        reason: 'insufficient_fee_per_gas',
        success: true,
        txsEvicted: [],
      });
    });

    it('returns empty result for CHAIN_PRUNED event', async () => {
      const context: EvictionContext = {
        event: EvictionEvent.CHAIN_PRUNED,
        blockNumber: BlockNumber(1),
      };

      const result = await rule.evict(context, pool);

      expect(result).toEqual({
        reason: 'insufficient_fee_per_gas',
        success: true,
        txsEvicted: [],
      });
    });

    it('leaves underpriced txs alone on BLOCK_MINED event', async () => {
      const blockHeader = BlockHeader.empty();
      blockHeader.globalVariables.blockNumber = BlockNumber(100);
      blockHeader.globalVariables.gasFees = new GasFees(10, 20);

      const tx = stubTxMetaData('0x1111', { maxFeesPerGas: new GasFees(0, 0) });
      pool = createPoolOps([tx]);

      const minedContext: EvictionContext = {
        event: EvictionEvent.BLOCK_MINED,
        block: blockHeader,
        newNullifiers: [],
        feePayers: [],
      };

      const result = await rule.evict(minedContext, pool);

      expect(result).toEqual({
        reason: 'insufficient_fee_per_gas',
        success: true,
        txsEvicted: [],
      });
      expect(deleteTxsMock).not.toHaveBeenCalled();
    });
  });

  describe('SLOT_PREPARED events', () => {
    const context: EvictionContext = {
      event: EvictionEvent.SLOT_PREPARED,
      slotNumber: SlotNumber(100),
    };

    it('evicts txs with insufficient DA fee per gas', async () => {
      const tx1 = stubTxMetaData('0x1111', { maxFeesPerGas: new GasFees(9, 20) }); // DA too low
      const tx2 = stubTxMetaData('0x2222', { maxFeesPerGas: new GasFees(10, 20) }); // Exactly enough

      pool = createPoolOps([tx1, tx2]);

      const result = await rule.evict(context, pool);

      expect(result.success).toBe(true);
      expect(result.txsEvicted).toEqual([tx1.txHash]);
      expect(deleteTxsMock).toHaveBeenCalledWith([tx1.txHash], 'InsufficientFeePerGas');
    });

    it('evicts txs with insufficient L2 fee per gas', async () => {
      const tx1 = stubTxMetaData('0x1111', { maxFeesPerGas: new GasFees(10, 19) }); // L2 too low
      const tx2 = stubTxMetaData('0x2222', { maxFeesPerGas: new GasFees(10, 20) }); // Exactly enough

      pool = createPoolOps([tx1, tx2]);

      const result = await rule.evict(context, pool);

      expect(result.success).toBe(true);
      expect(result.txsEvicted).toEqual([tx1.txHash]);
      expect(deleteTxsMock).toHaveBeenCalledWith([tx1.txHash], 'InsufficientFeePerGas');
    });

    it('keeps txs with sufficient fees', async () => {
      const tx1 = stubTxMetaData('0x1111', { maxFeesPerGas: new GasFees(10, 20) });
      const tx2 = stubTxMetaData('0x2222', { maxFeesPerGas: new GasFees(100, 200) });

      pool = createPoolOps([tx1, tx2]);

      const result = await rule.evict(context, pool);

      expect(result.success).toBe(true);
      expect(result.txsEvicted).toEqual([]);
      expect(deleteTxsMock).not.toHaveBeenCalled();
    });

    it('handles empty pending list', async () => {
      pool = createPoolOps([]);

      const result = await rule.evict(context, pool);

      expect(result).toEqual({
        reason: 'insufficient_fee_per_gas',
        success: true,
        txsEvicted: [],
      });
      expect(deleteTxsMock).not.toHaveBeenCalled();
    });

    it('uses the next-block min fee to determine the eviction threshold', async () => {
      // The next-block fee (5, 10) is lower than the default (10, 20) used by the other tests.
      rule = new InsufficientFeePerGasEvictionRule({ getNextBlockMinFees: () => Promise.resolve(new GasFees(5, 10)) });

      const tx1 = stubTxMetaData('0x1111', { maxFeesPerGas: new GasFees(5, 10) }); // Sufficient for projected fees
      const tx2 = stubTxMetaData('0x2222', { maxFeesPerGas: new GasFees(4, 10) }); // DA too low for projected fees

      pool = createPoolOps([tx1, tx2]);

      const result = await rule.evict(context, pool);

      expect(result.success).toBe(true);
      // Only tx2 is evicted (DA fee 4 < projected 5)
      expect(result.txsEvicted).toEqual([tx2.txHash]);
      expect(deleteTxsMock).toHaveBeenCalledWith([tx2.txHash], 'InsufficientFeePerGas');
    });

    it('skips the sweep when the next-block min fee is unavailable', async () => {
      rule = new InsufficientFeePerGasEvictionRule({ getNextBlockMinFees: () => Promise.resolve(undefined) });

      // Priced below every plausible fee, so only unavailability can save it.
      const tx = stubTxMetaData('0x1111', { maxFeesPerGas: new GasFees(0, 0) });
      pool = createPoolOps([tx]);

      const result = await rule.evict(context, pool);

      expect(result).toEqual({ reason: 'insufficient_fee_per_gas', success: true, txsEvicted: [] });
      expect(deleteTxsMock).not.toHaveBeenCalled();
    });
  });
});
