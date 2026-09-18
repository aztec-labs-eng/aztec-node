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
