Commit: e0faa6f3b664afc820b291e6925e301d902f3818; bb.js: 6.0.0-nightly.20260916; native: 6.0.0-nightly.20260916.

v24.15.0; darwin 24.6.0 arm64; Apple M4 Pro; one backend thread.

Run from yarn-project: `SPONGE_BENCH=1 JEST_MAX_WORKERS=1 yarn workspace @aztec-labs/blob-lib test src/sponge_blob.bench.test.ts`. Output prefix: `/Users/maximvezenov/Documents/dev/aztec-labs-eng/aztec-node/yarn-project/blob-lib/bench-out/sponge`.

Fresh sponge through squeeze, including field serialization. Startup, input generation, validation and reporting excluded.

Three warmups per pair; three-operation pilot selects a common repetition count targeting 100 ms for the faster algorithm, capped at 1,000. Fifteen samples alternate old/new order. No dependent permutations are pipelined.

Times are medians with interquartile ranges [Q1, Q3]; raw sample totals, IQR widths and pilot timings are in JSON. The cap and timing variation can leave samples below 100 ms. No speedup threshold is enforced.

| Backend | Fields | Chunk | Old ms/op [Q1, Q3] | New ms/op [Q1, Q3] | Old/new | Repetitions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| native UDS | 3 | 3 | 0.0321 [0.0313, 0.0337] | 0.0321 [0.0317, 0.0328] | 1.00x | 1000 |
| native UDS | 30 | 30 | 0.3066 [0.3023, 0.3082] | 0.1186 [0.1181, 0.1202] | 2.59x | 861 |
| native UDS | 300 | 300 | 3.0362 [3.0258, 3.0626] | 0.6907 [0.6882, 0.7059] | 4.40x | 147 |
| native UDS | 3000 | 3000 | 30.2767 [30.0254, 30.6084] | 6.2864 [6.2635, 6.4118] | 4.82x | 16 |
| native UDS | 24576 | 24576 | 246.8493 [244.4075, 249.0037] | 52.5721 [51.9426, 54.1578] | 4.70x | 2 |
| native UDS | 24576 | 50 | 246.5866 [245.2175, 248.0648] | 66.4582 [65.3970, 66.6874] | 3.71x | 2 |
| native UDS | 24576 | 500 | 246.2833 [244.8332, 249.6774] | 52.4966 [52.1665, 53.6765] | 4.69x | 2 |
| native async SHM | 3 | 3 | 0.0242 [0.0240, 0.0245] | 0.0244 [0.0242, 0.0246] | 0.99x | 1000 |
| native async SHM | 30 | 30 | 0.2240 [0.2203, 0.2251] | 0.1125 [0.1108, 0.1143] | 1.99x | 888 |
| native async SHM | 300 | 300 | 2.2274 [2.2193, 2.2436] | 0.6925 [0.6858, 0.7058] | 3.22x | 146 |
| native async SHM | 3000 | 3000 | 22.1640 [21.9887, 22.3447] | 6.3470 [6.3204, 6.4178] | 3.49x | 16 |
| native async SHM | 24576 | 24576 | 181.4691 [181.0177, 183.2001] | 53.4096 [53.1321, 53.7036] | 3.40x | 2 |
| native async SHM | 24576 | 50 | 180.3526 [179.8999, 182.1273] | 70.8901 [70.2798, 71.1418] | 2.54x | 2 |
| native async SHM | 24576 | 500 | 181.0770 [180.2542, 182.7650] | 53.3756 [53.2724, 54.8482] | 3.39x | 2 |
| native sync SHM | 3 | 3 | 0.0177 [0.0177, 0.0179] | 0.0178 [0.0178, 0.0180] | 1.00x | 1000 |
| native sync SHM | 30 | 30 | 0.1617 [0.1602, 0.1633] | 0.0884 [0.0880, 0.0894] | 1.83x | 1000 |
| native sync SHM | 300 | 300 | 1.6029 [1.5925, 1.6090] | 0.7000 [0.6927, 0.7083] | 2.29x | 144 |
| native sync SHM | 3000 | 3000 | 15.8979 [15.8766, 16.0256] | 6.5759 [6.5152, 6.5961] | 2.42x | 15 |
| native sync SHM | 24576 | 24576 | 130.4948 [129.7189, 130.9850] | 53.7251 [53.2486, 53.9666] | 2.43x | 2 |
| native sync SHM | 24576 | 50 | 130.9919 [129.7963, 131.5443] | 61.1297 [60.6435, 61.4225] | 2.14x | 2 |
| native sync SHM | 24576 | 500 | 130.6451 [130.2847, 131.7798] | 55.4858 [55.3391, 55.8851] | 2.35x | 2 |
| sync Wasm | 3 | 3 | 0.0247 [0.0244, 0.0249] | 0.0249 [0.0247, 0.0249] | 0.99x | 1000 |
| sync Wasm | 30 | 30 | 0.2246 [0.2238, 0.2273] | 0.1492 [0.1484, 0.1497] | 1.51x | 652 |
| sync Wasm | 300 | 300 | 2.2386 [2.2322, 2.2483] | 1.2797 [1.2744, 1.2844] | 1.75x | 78 |
| sync Wasm | 3000 | 3000 | 22.3172 [22.1787, 22.3724] | 12.5271 [12.4795, 12.5542] | 1.78x | 8 |
| sync Wasm | 24576 | 24576 | 182.6790 [182.3102, 184.7955] | 102.7690 [102.3840, 103.0169] | 1.78x | 1 |
| sync Wasm | 24576 | 50 | 183.3741 [181.9191, 184.3840] | 107.8560 [107.7507, 108.3179] | 1.70x | 1 |
| sync Wasm | 24576 | 500 | 182.8405 [182.3966, 184.3052] | 102.9639 [102.5331, 103.3446] | 1.78x | 1 |
