import type { BenchmarkingContract } from '@aztec-labs/noir-test-contracts.js/Benchmarking';
import type { SequencerClient } from '@aztec-labs/sequencer-client';
import { Metrics } from '@aztec-labs/telemetry-client';

import type { EndToEndContext } from '../fixtures/utils.js';
import { benchmarkSetup, sendTxs, waitTxs } from './utils.js';

const AZTEC_SLOT_DURATION_SECONDS = 600;
const ETHEREUM_SLOT_DURATION_SECONDS = 12;
const BLOCK_DURATION_MS = 110_000;
const L1_TX_TIMEOUT_MS = 30 * 60 * 1000;

// Block-building latency benchmark. Uses benchmarkSetup() (wraps setup() with telemetry override) and
// emits BENCH_OUTPUT JSON for the GitHub Benchmark Action. Measures sequencer block-build duration and
// mana throughput across 32-tx standard and 8-tx compute-heavy block configurations.
describe('benchmarks/build_block', () => {
  let context: EndToEndContext;
  let contract: BenchmarkingContract;
  let sequencer: SequencerClient;

  beforeEach(async () => {
    ({ context, contract, sequencer } = await benchmarkSetup({
      maxTxsPerBlock: 1024,
      // The production timing profile requires at least four block opportunities per slot. With
      // S=600s, init=1s, assemble=1s, P=2s, and D=110s, the timetable derives
      // floor((600 - 1 - (1 + 2*2 + 110)) / 110) = 4. The first build deadline is 111s into
      // the slot, leaving ample headroom to measure the block build without deadline truncation.
      aztecSlotDuration: AZTEC_SLOT_DURATION_SECONDS,
      ethereumSlotDuration: ETHEREUM_SLOT_DURATION_SECONDS,
      blockDurationMs: BLOCK_DURATION_MS,
      enableDelayer: false,
      txTimeoutMs: L1_TX_TIMEOUT_MS,
      txCancellationFinalTimeoutMs: L1_TX_TIMEOUT_MS,
      metrics: [
        Metrics.SEQUENCER_BLOCK_BUILD_DURATION,
        {
          // Invert mana-per-second since benchmark action requires that all metrics
          // conform to either "bigger-is-better" or "smaller-is-better".
          name: 'aztec.sequencer.block.time_per_mana',
          source: Metrics.SEQUENCER_BLOCK_BUILD_MANA_PER_SECOND,
          unit: 'us/mana',
          transform: (value: number) => 1e6 / value,
        },
      ],
    }));
  });

  afterEach(async () => {
    await context?.teardown();
  });

  const TX_COUNT = 32;
  it(`builds a block with ${TX_COUNT} standard txs`, async () => {
    sequencer.updateConfig({ minTxsPerBlock: TX_COUNT });
    const sentTxs = await sendTxs(TX_COUNT, context, contract);
    await waitTxs(sentTxs, context);
  });

  const TX_COUNT_HEAVY_COMPUTE = 8;
  it(`builds a block with ${TX_COUNT_HEAVY_COMPUTE} compute-heavy txs`, async () => {
    sequencer.updateConfig({ minTxsPerBlock: TX_COUNT_HEAVY_COMPUTE });
    const sentTxs = await sendTxs(TX_COUNT_HEAVY_COMPUTE, context, contract, /*heavyPublicComput=*/ true);
    await waitTxs(sentTxs, context);
  });
});
