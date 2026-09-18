# Prover Client

## Lightweight checkpoint benchmark

The checkpoint builder benchmark reports median `buildHeaderAndBody` and total `addBlock` time for worst-case and
contract-class-log-heavy blocks. Each case runs three warmups and 15 measured samples. Every sample creates a fresh
builder and world-state fork; transaction fixture generation is outside the measured interval.

Run it from `yarn-project`:

```sh
yarn workspace @aztec-labs/prover-client test src/light/lightweight_checkpoint_builder.bench.test.ts
```

Set `BENCH_OUTPUT=bench-out/lightweight-checkpoint.json` to write the median-only result records locally. Keep generated
benchmark output out of source control.
