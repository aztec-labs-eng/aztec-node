#!/usr/bin/env bash
# Splits nargo tests into chunks for run_test_chunk.sh.
#
# Reads `nargo test --list-tests` output (`<package> <test>` lines) on stdin and prints one
# `<package> <kind> <chunk>/<num_chunks>` line per chunk, with <chunk> 1-based. <kind> is "oracle" for a package's
# __oracle_test__ tests and "txe" for the rest, or "all" for every test of a package with no __oracle_test__ tests.
# Each (package, kind) group is split into as few chunks as keep every chunk at or under 64 tests.
set -euo pipefail

awk -v size=64 '
  {
    oracle = $2 ~ /__oracle_test__/
    count[$1 " " (oracle ? "oracle" : "txe")]++
    if (oracle) has_oracle[$1] = 1
  }
  END {
    for (group in count) {
      split(group, g, " ")
      kind = (g[2] == "txe" && !(g[1] in has_oracle)) ? "all" : g[2]
      num_chunks = int((count[group] + size - 1) / size)
      for (chunk = 1; chunk <= num_chunks; chunk++) print g[1], kind, chunk "/" num_chunks
    }
  }' | sort -k1,1 -k2,2 -k3,3n
