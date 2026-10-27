import { L1Metrics, type L1MetricsClient } from './l1_metrics.js';
import { L1_BLOB_BASE_FEE_WEI, L1_BLOCK_HEIGHT, L1_GAS_PRICE_WEI } from './metrics.js';
import { InMemoryMetrics } from './test/in_memory_metrics.js';

describe('L1Metrics', () => {
  let metrics: InMemoryMetrics;
  let l1Metrics: L1Metrics;

  const client: L1MetricsClient = {
    getBlockNumber: () => Promise.resolve(123n),
    getGasPrice: () => Promise.resolve(7_000_000_000n),
    getBlobBaseFee: () => Promise.resolve(3n),
  };

  beforeEach(() => {
    metrics = new InMemoryMetrics();
    l1Metrics = new L1Metrics(metrics.getMeter('L1Metrics'), client, 1, 'sequencer');
    l1Metrics.start();
  });

  afterEach(async () => {
    l1Metrics.stop();
    await metrics.stop();
  });

  it('exports the L1 block height, gas price and blob base fee', async () => {
    const exported = await metrics.collect();

    expect(exported[L1_BLOCK_HEIGHT.name]).toEqual([{ value: 123, attributes: {} }]);
    expect(exported[L1_GAS_PRICE_WEI.name]).toEqual([{ value: 7_000_000_000, attributes: {} }]);
    expect(exported[L1_BLOB_BASE_FEE_WEI.name]).toEqual([{ value: 3, attributes: {} }]);
  });
});
