import { createLogger } from '@aztec-labs/foundation/log';
import type { NextBlockMinFeesProvider } from '@aztec-labs/stdlib/gas';

import type { EvictionContext, EvictionResult, EvictionRule, PoolOperations } from './interfaces.js';
import { EvictionEvent } from './interfaces.js';

/**
 * Eviction rule that removes transactions whose maxFeesPerGas no longer meets the fee the next block will
 * charge, after a new block is mined. Only triggers on BLOCK_MINED events.
 *
 * Skips the sweep when that fee cannot be resolved, rather than evicting against a stand-in price that would
 * drop transactions which are in fact payable.
 */
export class InsufficientFeePerGasEvictionRule implements EvictionRule {
  public readonly name = 'InsufficientFeePerGas';

  private log = createLogger('p2p:tx_pool_v2:insufficient_fee_per_gas_eviction_rule');

  constructor(private nextBlockMinFeesProvider: NextBlockMinFeesProvider) {}

  async evict(context: EvictionContext, pool: PoolOperations): Promise<EvictionResult> {
    if (context.event !== EvictionEvent.BLOCK_MINED) {
      return {
        reason: 'insufficient_fee_per_gas',
        success: true,
        txsEvicted: [],
      };
    }

    try {
      const gasFees = await this.nextBlockMinFeesProvider.getNextBlockMinFees();
      if (!gasFees) {
        this.log.verbose(`Skipping the insufficient-fee sweep: cannot resolve the next block's min fee`);
        return { reason: 'insufficient_fee_per_gas', success: true, txsEvicted: [] };
      }

      const txsToEvict: string[] = [];
      const pendingTxs = pool.getPendingTxs();

      for (const meta of pendingTxs) {
        const maxFeesPerGas = meta.data.constants.txContext.gasSettings.maxFeesPerGas;
        if (maxFeesPerGas.feePerDaGas < gasFees.feePerDaGas || maxFeesPerGas.feePerL2Gas < gasFees.feePerL2Gas) {
          this.log.verbose(`Evicting tx ${meta.txHash} from pool due to insufficient fee per gas`, {
            txMaxFeesPerGas: maxFeesPerGas.toInspect(),
            blockGasFees: gasFees.toInspect(),
          });
          txsToEvict.push(meta.txHash);
        }
      }

      if (txsToEvict.length > 0) {
        this.log.info(`Evicted ${txsToEvict.length} txs with insufficient fee per gas after block mined`, {
          txsToEvict,
        });
        await pool.deleteTxs(txsToEvict, this.name);
      }

      return {
        reason: 'insufficient_fee_per_gas',
        success: true,
        txsEvicted: txsToEvict,
      };
    } catch (err) {
      this.log.error('Failed to evict transactions with insufficient fee per gas', { err });
      return {
        reason: 'insufficient_fee_per_gas',
        success: false,
        txsEvicted: [],
        error: new Error('Failed to evict txs with insufficient fee per gas', { cause: err }),
      };
    }
  }
}
