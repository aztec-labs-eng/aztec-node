import type { PublicClient } from 'viem';

import { L1_TX_SCOPE } from './attributes.js';
import { L1_BLOB_BASE_FEE_WEI, L1_BLOCK_HEIGHT, L1_GAS_PRICE_WEI, L1_PUBLISHER_LOADED_COUNT } from './metrics.js';
import type { BatchObservableResult, Meter, ObservableGauge } from './telemetry.js';

/** L1 client reads needed by {@link L1Metrics}. */
export type L1MetricsClient = Pick<PublicClient, 'getBlockNumber' | 'getGasPrice' | 'getBlobBaseFee'>;

/** Reports the L1 block height and fees, and how many publishers a sequencer or prover has loaded. */
export class L1Metrics {
  private l1BlockHeight: ObservableGauge;
  private gasPriceWei: ObservableGauge;
  private blobBaseFeeWei: ObservableGauge;

  constructor(
    private meter: Meter,
    private client: L1MetricsClient,
    publisherCount: number,
    scope: 'sequencer' | 'prover',
  ) {
    this.l1BlockHeight = meter.createObservableGauge(L1_BLOCK_HEIGHT);
    this.gasPriceWei = meter.createObservableGauge(L1_GAS_PRICE_WEI);
    this.blobBaseFeeWei = meter.createObservableGauge(L1_BLOB_BASE_FEE_WEI);

    meter.createGauge(L1_PUBLISHER_LOADED_COUNT).record(publisherCount, { [L1_TX_SCOPE]: scope });
  }

  start() {
    this.meter.addBatchObservableCallback(this.observe, this.getObservables());
  }

  stop() {
    this.meter.removeBatchObservableCallback(this.observe, this.getObservables());
  }

  private getObservables() {
    return [this.l1BlockHeight, this.gasPriceWei, this.blobBaseFeeWei];
  }

  private observe = async (observer: BatchObservableResult) => {
    const [blockNumber, gasPrice, blobFee] = await Promise.all([
      this.client.getBlockNumber(),
      this.client.getGasPrice(),
      this.client.getBlobBaseFee(),
    ]);

    observer.observe(this.l1BlockHeight, Number(blockNumber));
    observer.observe(this.gasPriceWei, Number(gasPrice));
    observer.observe(this.blobBaseFeeWei, Number(blobFee));
  };
}
