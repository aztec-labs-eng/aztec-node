# Sponge absorption benchmark

This opt-in benchmark compares repeated Poseidon2 permutations with absorb-chain in the production sponge. It measures
native UDS, native async SHM, native sync SHM, and synchronous in-process Wasm serially, with one backend thread.
The primary comparison is **old versus new on native sync SHM**. There is no performance pass/fail threshold and no
recurring CI registration.

From `yarn-project`, after installing dependencies and building the workspace:

```sh
SPONGE_BENCH=1 JEST_MAX_WORKERS=1 yarn workspace @aztec-labs/blob-lib test src/sponge_blob.bench.test.ts
```

Results are written to `blob-lib/bench-out/sponge.json` and `blob-lib/bench-out/sponge.md`. Set `SPONGE_BENCH_OUTPUT` to
change the output prefix (relative to `blob-lib`, or absolute). Native binaries and the SHM NAPI module are discovered
through the pinned bb.js package. `BB_BINARY_PATH` and `BB_WASM_PATH` overrides are recorded in the results. Explicit
backend selection never falls back: initialization failures are saved alongside available results and fail the test.

Each operation creates a fresh sponge, absorbs precomputed deterministic chunks, and squeezes once. The benchmark
replaces only the imported crypto helpers to select the real backend, retaining foundation's field serialization.
The old algorithm is the field-by-field test baseline. Both versions retain the production async interface and blob
field-count bookkeeping. No dependent permutations are pipelined.

Each backend/algorithm/scenario gets three complete warmups. A separate three-operation pilot chooses one common
repetition count for each old/new pair, targeting 100 ms for the faster algorithm, capped at 1,000 repetitions. Fifteen
sample pairs alternate old/new execution order. Timing includes sponge creation, absorption, serialization and squeeze;
it excludes startup, inputs, assertions and reporting. The cap or subsequent timing variation can produce shorter
samples. JSON contains sample totals in milliseconds; divide by repetitions for per-operation times.

The table reports median milliseconds per operation and the interquartile interval [Q1, Q3]. Quartiles are the medians
of the lower and upper seven observations, excluding the overall median. JSON also records IQR widths. Old/new speedup
is the ratio of medians; overlapping intervals should be treated cautiously, and these runs do not establish statistical
significance. Compare old/new within a backend to isolate batching; compare UDS/sync SHM using the same algorithm to
isolate transport changes.

Untimed validation compares every sponge field (including unused cache slots and absorbed-field count) after every
chunk, plus the final hash and state. All backends must agree. Validation includes all seven measured scenarios,
empty input, and the existing partial-cache boundary cases. Chunks of 50 and 500 preserve their final partial chunk.

Run on an otherwise idle machine. The JSON records the source commit, working-tree status, bb.js and native versions,
binary paths, Node, OS, CPU, thread count and reproduction command. Results from a historical image are not mixed with
this benchmark's measurements.

## Recorded run

[Complete results](./sponge-m4-pro.md) and [raw samples/environment](./sponge-m4-pro.json) were collected on an Apple M4 Pro
with Node v24.15.0 and bb.js/native 6.0.0-nightly.20260916, from clean commit
`e0faa6f3b664afc820b291e6925e301d902f3818`. All four backends passed all 20 validation cases, including cross-backend
state and hash equality.

Batching remains useful over **sync SHM**: old/new speedup is 1.83x at 30 fields, 2.29x at 300, 2.42x at 3,000, and
2.14–2.43x at 24,576 fields depending on chunk size. Across workloads of at least 30 fields, batching saves 2.59–4.82x
on UDS, 1.99–3.49x on async SHM, and 1.51–1.78x on sync Wasm. It reduces backend calls and moves full-block absorption
into native/Wasm code; serialization and the final permutation remain in the measured operation.

Three-field medians regress slightly: UDS +0.10%, async SHM +0.72%, sync SHM +0.34%, and Wasm +0.75%. All four old/new
interquartile intervals overlap, so these differences are inconclusive. Three fields do not invoke absorb-chain.

Transport changes have a different effect. The following ratios compare UDS with sync SHM **using the same algorithm**;
values above 1 mean sync SHM is faster:

| Fields | Chunk | Old UDS / old sync SHM | New UDS / new sync SHM |
| ---: | ---: | ---: | ---: |
| 3 | 3 | 1.81x | 1.80x |
| 30 | 30 | 1.90x | 1.34x |
| 300 | 300 | 1.89x | 0.99x |
| 3,000 | 3,000 | 1.90x | 0.96x |
| 24,576 | 24,576 | 1.89x | 0.98x |
| 24,576 | 50 | 1.88x | 1.09x |
| 24,576 | 500 | 1.89x | 0.95x |

Sync SHM cuts the old algorithm's time by roughly 45–47%. With absorb-chain, it helps small inputs and 50-field chunks,
but is slightly slower for the other larger cases in this run. The new 300-field and 24,576-field single-chunk intervals
overlap; their transport differences are inconclusive. The new 3,000-field and 500-field-chunk cases show observed
slowdowns of about 4.6% and 5.7%. Backend order is fixed and this is one machine/run, so timing drift remains a limitation.

194 of 840 samples were shorter than 100 ms, primarily because of the 1,000-repetition cap on small operations and
variation after the pilot. All requested samples and repetitions are retained, with no filtering or outlier removal.

Validation commands completed successfully from `yarn-project`:

```sh
./bootstrap.sh
yarn build
yarn format
yarn format --check
yarn lint
JEST_MAX_WORKERS=1 yarn workspace @aztec-labs/blob-lib test src/sponge_blob.test.ts --forceExit
JEST_MAX_WORKERS=1 yarn workspace @aztec-labs/blob-lib test src/sponge_blob.bench.test.ts
SPONGE_BENCH=1 JEST_MAX_WORKERS=1 yarn workspace @aztec-labs/blob-lib test src/sponge_blob.bench.test.ts
```

The existing suite passed before and after the change (15 tests, two snapshots). Its singleton kept the first Jest
process open after success; the second run used `--forceExit`. The benchmark is skipped without opt-in and exits
normally after an enabled run. Missing local dependencies and contract artifacts were installed/built before the final
checks; toolchain pins and standard-contract address pins were unchanged.
