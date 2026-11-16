#!/usr/bin/env bash
# Benchmarks the TXE on noir-projects/txe-bench/account_scaling: the same private workload with 5, 20 and 40 accounts in the test.
#
# Each test runs alone against a fresh TXE. The value recorded is nargo's execution time for the test, which leaves out
# compiling the package, so it measures the TXE and the contract execution it drives. Requires the contracts and the
# TXE to be built. Driven by noir-contracts' bootstrap.sh bench_cmds.
set -euo pipefail

cd "$(dirname "$0")/.."

root=$(git rev-parse --show-toplevel)
nargo=${NARGO:-$root/labs-aztec-toolchain/bin/nargo}
port=${TXE_BENCH_PORT:-14790}
output="${BENCH_OUTPUT:-bench-out/txe-account-scaling.bench.json}"
package_dir=../txe-bench/account_scaling
work=$(mktemp -d)
txe_pid=

function stop_txe {
  if [ -n "$txe_pid" ]; then
    kill "$txe_pid" 2>/dev/null || true
    wait "$txe_pid" 2>/dev/null || true
    txe_pid=
  fi
}
trap 'stop_txe; rm -rf "$work"' EXIT

function start_txe {
  (cd "$root/yarn-project/txe" && exec env LOG_LEVEL=silent TXE_PORT=$port node --no-warnings ./dest/bin/index.js) \
    >"$work/txe.log" 2>&1 &
  txe_pid=$!
  for _ in $(seq 120); do
    if (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null; then
      return
    fi
    sleep 0.5
  done
  echo "TXE did not start on port $port." >&2
  cat "$work/txe.log" >&2
  exit 1
}

rows=()
for accounts in 05 20 40; do
  test_name="accounts_$accounts"
  start_txe
  if ! RAYON_NUM_THREADS=1 NARGO_FOREIGN_CALL_TIMEOUT=3600000 "$nargo" test --program-dir "$package_dir" \
    --silence-warnings --skip-brillig-constraints-check --oracle-resolver "http://127.0.0.1:$port" \
    --test-threads 1 --format json --exact "$test_name" >"$work/$test_name.jsonl" 2>"$work/$test_name.err"; then
    echo "Benchmark test $test_name failed." >&2
    cat "$work/$test_name.jsonl" "$work/$test_name.err" >&2
    exit 1
  fi
  stop_txe
  exec_time=$(jq -s -r --arg name "$test_name" \
    'map(select(.type == "test" and .event == "ok" and (.name | endswith($name))))[0].exec_time' "$work/$test_name.jsonl")
  echo "$test_name: ${exec_time}s" >&2
  rows+=("$(jq -n --arg name "txe/account-scaling/$test_name" --argjson value "$exec_time" \
    '{name: $name, unit: "s", value: $value}')")
done

mkdir -p "$(dirname "$output")"
printf '%s\n' "${rows[@]}" | jq -s . >"$output"
echo "Wrote TXE benchmark to $output." >&2
