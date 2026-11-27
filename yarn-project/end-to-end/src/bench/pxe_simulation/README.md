# PXE simulation benchmark

Measures PXE simulation and witness generation time, excluding proving and the node's execution time. Node calls are
counted as round trips instead (concurrent calls count once), so that latency can be modeled as
`client_ms + round_trips × L`.

The same scenario runs in Node (LMDB, native) and in a browser (sqlite on OPFS, wasm), on a fresh account and after it
has sent transactions.

## Metrics

For each operation (simulation, witness generation, proof input preparation, utility simulation), the median over
several iterations of:

- `client_ms`: wall time minus the time blocked on the node.
- `round_trips`: round trips to the node, counted on the node client's requests, so the wallet's calls are included and
  reads the PXE serves from its cache are not.

Named `pxe_simulation/<environment>/<state>/<operation>/<metric>`.

## Setup

- No prover node, so that background proving does not compete for the CPU.
- Both environments reach the node over JSON-RPC. In the browser, the scenario runs in a page (`browser_page/`) that
  only creates the wallet and exposes the scenario to the test; vite builds it and Playwright opens it in a persistent
  context, so that OPFS is on disk.
- Measuring sends nothing, so every iteration runs on the same state. An unrelated block is mined before each
  simulation so that it has a block to sync; witness generation runs on the same block as its simulation.

## Running

```bash
BENCH_OUTPUT=bench-out/pxe_simulation_node.bench.json yarn test:e2e pxe_simulation/node
BENCH_OUTPUT=bench-out/pxe_simulation_browser.bench.json yarn test:e2e pxe_simulation/browser
```

Compare runs with `ci3/bench_compare`: local runs are too noisy for small differences.

## Limitations

- Medians reflect warm caches: a wallet's first operation after starting is not reported.
- Encoding requests as JSON and parsing responses count as node time, although the client does that work.
