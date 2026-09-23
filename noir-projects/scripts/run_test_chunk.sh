#!/usr/bin/env bash
# Runs one chunk of a package's tests in a single nargo process.
#
# Usage: run_test_chunk.sh <sub_project> <package> <kind> <chunk> <num_chunks> <port> [<num_ports>]
#
# <kind> selects the package's __oracle_test__ tests ("oracle") or all its other tests ("txe"). The selected
# tests are sorted and dealt round-robin into <num_chunks> chunks, and this runs chunk <chunk> (0-based).
# nargo elaborates the package once per test thread rather than once per test, so a chunk costs a
# handful of package compilations instead of one per test.
#
# Oracles resolve at one of <num_ports> (default 1) consecutive ports from <port>, picked at random here
# rather than by the caller: the command line is the test's cache key, so it must not depend on which
# server a chunk happens to be assigned to.
set -euo pipefail

sub_project=$1
package=$2
kind=$3
chunk=$4
num_chunks=$5
port=$(($6 + RANDOM % ${7:-1}))

cd $(dirname $0)/../$sub_project

export RAYON_NUM_THREADS=1
export NARGO_FOREIGN_CALL_TIMEOUT=300000
export NARGO=${NARGO:-$(git rev-parse --show-toplevel)/labs-aztec-toolchain/bin/nargo}

case $kind in
  oracle) grep_args=() ;;
  txe) grep_args=(-v) ;;
  *)
    echo "Unknown test kind '$kind', expected 'oracle' or 'txe'." >&2
    exit 1
    ;;
esac

list=$($NARGO test --list-tests --silence-warnings --package $package |
  awk '{print $2}' | { grep "${grep_args[@]}" __oracle_test__ || true; } | sort |
  awk -v n=$num_chunks -v k=$chunk '(NR - 1) % n == k')
if [ -z "$list" ]; then
  echo "No $kind tests in chunk $chunk of $num_chunks for package $package." >&2
  exit 1
fi
mapfile -t tests <<< "$list"

# CPUS is the command's CPU budget: ci3/source_test_params defaults it to 2, matching the test engine
# running one command per 2 CPUs. Every test thread elaborates the package itself, so a thread with no
# test to run is pure overhead.
threads=${CPUS:-2}
[ ${#tests[@]} -lt $threads ] && threads=${#tests[@]}

echo "Running ${#tests[@]} $kind tests of $package on $threads threads against port $port."
$NARGO test --silence-warnings --skip-brillig-constraints-check --oracle-resolver http://127.0.0.1:$port \
  --package $package --test-threads $threads --exact "${tests[@]}"
