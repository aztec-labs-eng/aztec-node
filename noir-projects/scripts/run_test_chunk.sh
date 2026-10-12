#!/usr/bin/env bash
# Runs one chunk of a package's tests in a single nargo process.
#
# Usage: run_test_chunk.sh <sub_project> <package> <kind> <chunk>/<num_chunks> <port> [<num_ports>]
#
# <kind> selects the package's __oracle_test__ tests ("oracle"), its other tests ("txe"), or all of them ("all").
# The selected tests are sorted and dealt round-robin into <num_chunks> chunks, and this runs chunk <chunk>
# (1-based). nargo elaborates the package once per test thread rather than once per test, so a chunk costs a
# handful of package compilations instead of one per test.
#
# Oracles resolve at one of <num_ports> (default 1) consecutive ports from <port>, picked at random here
# rather than by the caller: the command line is the test's cache key, so it must not depend on which
# server a chunk happens to be assigned to. To rerun a CI command against fewer servers than it names, such
# as a single local TXE, lower <num_ports> to match.
set -euo pipefail

sub_project=$1
package=$2
kind=$3
chunk=${4%/*}
num_chunks=${4#*/}
port=$(($5 + RANDOM % ${6:-1}))

cd $(dirname $0)/../$sub_project

export RAYON_NUM_THREADS=1
export NARGO_FOREIGN_CALL_TIMEOUT=300000
export NARGO=${NARGO:-$(git rev-parse --show-toplevel)/labs-aztec-toolchain/bin/nargo}

case $kind in
  oracle) filter=(grep __oracle_test__) ;;
  txe) filter=(grep -v __oracle_test__) ;;
  all) filter=(cat) ;;
  *)
    echo "Unknown test kind '$kind', expected 'oracle', 'txe' or 'all'." >&2
    exit 1
    ;;
esac

# Listing the tests elaborates the package, so skip it when the chunk is the whole package.
if [ "$kind" == all ] && [ "$num_chunks" == 1 ]; then
  echo "Running all tests of $package against port $port."
  selection=()
else
  list=$($NARGO test --list-tests --silence-warnings --package $package |
    awk '{print $2}' | { "${filter[@]}" || true; } | sort |
    awk -v n=$num_chunks -v k=$chunk '(NR - 1) % n == k - 1')
  if [ -z "$list" ]; then
    echo "No $kind tests in chunk $chunk/$num_chunks for package $package." >&2
    exit 1
  fi
  mapfile -t tests <<< "$list"
  echo "Running ${#tests[@]} $kind tests of $package against port $port."
  selection=(--exact "${tests[@]}")
fi

# CPUS is the command's CPU budget: ci3/source_test_params defaults it to 2, matching the test engine
# running one command per 2 CPUs. nargo only elaborates the package on threads that pick up a test, so
# a chunk with fewer tests than threads wastes nothing.
$NARGO test --silence-warnings --skip-brillig-constraints-check --oracle-resolver http://127.0.0.1:$port \
  --package $package --test-threads ${CPUS:-2} "${selection[@]}"
