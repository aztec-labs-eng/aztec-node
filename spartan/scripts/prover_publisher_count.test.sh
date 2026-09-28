#!/usr/bin/env bash
set -euo pipefail

# Fixture-driven check on the prover publisher key range, run as:
#
#   spartan/scripts/prover_publisher_count.test.sh
#
# Each case pins the indices `calculate_publisher_indices.sh` allocates for a prover configuration. Publisher keys
# belong to prover nodes, so autoscaled agent capacity must not change the range.

spartan="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$spartan/scripts/prover_publisher_count.sh"

failures=0

# Asserts the total this configuration allocates. Args: label, expected total, then VAR=VALUE assignments.
expect_total() {
  local label="$1" expected="$2"
  shift 2
  local actual
  actual=$(
    unset PROVER_ENABLED PUBLISHERS_PER_PROVER
    for assignment in "$@"; do export "${assignment?}"; done
    source "$spartan/scripts/prover_publisher_count.sh"
    calculate_total_prover_publishers
    echo "$TOTAL_PROVER_PUBLISHERS"
  )
  if [[ "$actual" == "$expected" ]]; then
    echo "ok   - $label (total $actual)"
  else
    echo "FAIL - $label: expected total $expected, got $actual" >&2
    failures=$((failures + 1))
  fi
}

# Asserts the indices an environment file produces. Args: environment name, expected comma-separated prover indices.
expect_environment_indices() {
  local environment="$1" expected="$2"
  local actual
  # The prover range is the one starting at PROVER_PUBLISHER_MNEMONIC_START_INDEX (8000 by default).
  # `grep` finding nothing is the expected answer for a prover-less environment, not a failure.
  actual=$("$spartan/scripts/calculate_publisher_indices.sh" "$environment" | tr ',' '\n' |
    { grep -E '^8[0-9]{3}$' || true; } | tr '\n' ',' | sed 's/,$//')
  if [[ "$actual" == "$expected" ]]; then
    echo "ok   - $environment prover publisher indices ($actual)"
  else
    echo "FAIL - $environment prover publisher indices: expected '$expected', got '$actual'" >&2
    failures=$((failures + 1))
  fi
}

# An autoscaled prover is still one publisher-bearing node, so its agent ceiling does not widen the range.
expect_total "autoscaled prover, two publishers" 2 \
  PROVER_ENABLED=true PUBLISHERS_PER_PROVER=2 PROVER_AGENT_KEDA_ENABLED=true PROVER_AGENT_KEDA_MAX_REPLICAS=10
expect_total "fixed-size prover, two publishers" 2 \
  PROVER_ENABLED=true PUBLISHERS_PER_PROVER=2 PROVER_AGENT_KEDA_ENABLED=false PROVER_REPLICAS=4
expect_total "fixed-size prover, one publisher" 1 \
  PROVER_ENABLED=true PUBLISHERS_PER_PROVER=1 PROVER_REPLICAS=8
expect_total "disabled prover" 0 PROVER_ENABLED=false PUBLISHERS_PER_PROVER=2 PROVER_REPLICAS=4

expect_environment_indices fast-inbox "8000,8001"
expect_environment_indices mainnet ""

if (( failures > 0 )); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "All prover publisher sizing checks passed"
