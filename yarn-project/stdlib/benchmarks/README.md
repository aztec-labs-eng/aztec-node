# Transaction-effects transport benchmark

This opt-in benchmark measures existing Poseidon2 hashing over native UDS, native async SHM, and native sync SHM.
It uses production transaction-effects and tree code, with a benchmark-only replacement of the foundation hash helpers
to select each real backend. Field serialization, domain separators, Promise interfaces, and request scheduling are
preserved. Backend initialization must succeed explicitly; there is no fallback, native batching, or CI registration.

From `yarn-project`, after installing dependencies and building the workspace:

```sh
TX_EFFECTS_BENCH=1 JEST_MAX_WORKERS=1 yarn workspace @aztec-labs/stdlib test src/tx/tx_effects_transport.bench.test.ts
```

The default outputs are `stdlib/bench-out/tx-effects-transport.json` and `.md`. Set `TX_EFFECTS_BENCH_OUTPUT` to change
the output prefix. The JSON contains raw sample totals, repetitions, summaries, request diagnostics, responsiveness
samples, and environment metadata. The Markdown contains tables for a PR description. Results have no performance
pass/fail threshold. Run on an otherwise idle machine; comparisons on macOS do not establish production Linux performance.

Keep generated JSON and Markdown in the ignored `bench-out/` directory; include the report in the PR description, and
do not commit benchmark output.

## Workloads

- **Small hashes:** 64 independent three-field hashes, requested sequentially or concurrently with `Promise.all`.
  One operation is all 64 hashes.
- **Leaves:** `computeTxEffectsTreeData` computes categories and leaves with the existing concurrency.
- **Internal tree:** the existing unbalanced root helper over precomputed sparse-profile leaf buffers. It makes
  N−1 sequential three-field requests. Buffer preparation is excluded from this isolated measurement.
- **Complete commitment:** a fresh `Body.computeTxEffectsTree()` per operation, including leaf-buffer serialization.
  Fresh bodies avoid the categories/leaves cache. Effects objects are immutable throughout the run.

Effects workloads use 1, 3, 16, and 64 transactions; isolated internal-tree measurements omit the hash-free single leaf.
These deterministic synthetic profiles exercise different request sizes, rather than reproduce observed traffic:

| Profile | Effects per transaction | Leaf-construction hash requests per transaction |
| --- | --- | ---: |
| Sparse | One nullifier; all other categories empty | 3 |
| Small categories | Two note hashes, one nullifier, one L2-to-L1 message, one public data write, one two-field private log, one two-field public log | 8 |
| Log heavy | Small categories, with a full private log, a 64-field public log, and one full 3,023-field contract-class log | 10 |

Every profile also includes a deterministic transaction hash and fee. A leaf requires each nonempty category hash,
one combined categories hash, and one leaf hash; each contract-class log adds another hash. Complete commitments add
N−1 internal hashes. Diagnostics record every request's field count, including separators, outside timing. The largest
log-heavy case is a hashing stress control, not a claim that its total payload fits a deployed block's limits.

## Method and correctness

Each backend gets three warmups and a three-operation pilot for every scenario. The fastest pilot sets a common
repetition count across transports, targeting 100 ms per sample, capped at 1,000 repetitions. Three rounds collect
five samples each, rotating backend order (UDS/async/sync, async/sync/UDS, sync/UDS/async) and reversing scenario order
on the middle round. Each backend is recreated and warmed each round; only one measured backend is alive at a time.

Reported times are medians per complete operation with [Q1, Q3], the medians of the lower/upper seven samples excluding
the overall median. JSON also includes IQR widths and operations/second. Samples can be shorter than 100 ms due to the
cap and timing variation. All samples are retained. Overlapping intervals are inconclusive, and these are not statistical
significance tests. The finite fixture set and rotating rounds do not eliminate JIT, GC, or thermal effects.

Timing includes production serialization and async scheduling, but excludes initialization, fixture generation,
correctness checks, diagnostics, and reporting. Singleton initialization/selection is bypassed equally for all transports.
Before timing, every hash is checked against the unmodified foundation helper, outputs and request-size distributions
are compared across backends, request totals are checked, and the empty body is verified. The reference singleton is
destroyed before timing. Every scenario's output is checked again on each measured backend instance.

## Responsiveness probe

A separate probe runs four concurrent loops computing fresh 64-transaction small-category commitments for at least
one second. A worker thread independently sends a ping every 5 ms; the main thread echoes it and the worker records
round-trip latency. Only pings sent during the measured interval are included. The main thread also records the drift
of a 5 ms interval timer. Callbacks are allowed to run after hashing before the measurements are collected.

The probe repeats three times per backend in rotating order. It reports complete operations/second, ping p50/p95/max,
and maximum timer delay. Raw ping samples are retained. It intentionally does not yield between complete operations:
sync calls behind Promise wrappers can starve I/O through a continuous chain of microtasks. This is a synthetic
saturation probe, not an RPC load test or a prediction of a node's request latency. The worker, timer, and IPC overhead
are absent from the primary timing run.
