#!/usr/bin/env bash
# Splits nargo tests into chunks for run_test_chunk.sh.
#
# Reads `nargo test --list-tests` output (`<package> <test>` lines) on stdin and prints one
# `<package> <kind> <chunk> <num_chunks>` line per chunk, where <kind> is "oracle" for a package's
# __oracle_test__ tests and "txe" for the rest. Each (package, kind) group is split into as few chunks
# as keep every chunk at or under the chunk size (default 64).
set -euo pipefail

chunk_size=${1:-64}

awk -v size=$chunk_size '
  { count[$1 " " (($2 ~ /__oracle_test__/) ? "oracle" : "txe")]++ }
  END {
    for (group in count) {
      num_chunks = int((count[group] + size - 1) / size)
      for (chunk = 0; chunk < num_chunks; chunk++) print group, chunk, num_chunks
    }
  }' | sort
