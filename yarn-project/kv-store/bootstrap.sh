#!/usr/bin/env bash
source $(git rev-parse --show-toplevel)/ci3/source_bootstrap

hash=$(../bootstrap.sh hash)

# Directory prefixes, mirroring the project 'include' globs in vitest.config.ts.
# vitest picks a file's project from its own config, so a file listed in the
# wrong bucket here still runs in chromium but without ISOLATE, and then wedges
# silently until the CI timeout kills it. test_cmds therefore refuses to emit
# anything it cannot classify.
browser_dirs="src/deprecated/indexeddb src/sqlite-opfs"
node_dirs="src/interfaces src/lmdb src/lmdb-v2 src/stores"
# Benchmarks self-skip unless VITE_BENCH=1, so there is nothing for CI to run.
unscheduled_dirs="src/bench"

function under_any {
  local path=$1 dir
  shift
  for dir in "$@"; do
    [[ "$path" == "$dir/"* ]] && return 0
  done
  return 1
}

function test_cmds {
  local test
  for test in $(find src -name '*.test.ts' | sort); do
    if under_any "$test" $unscheduled_dirs; then
      continue
    elif under_any "$test" $browser_dirs; then
      # Browser tests (vitest + chromium). Each file runs in its own ISOLATE
      # container — running multiple files in a single vitest invocation
      # triggers a CDP teardown deadlock on the 2-CPU CI executor. See
      # scripts/run-browser-tests.sh for the root-cause analysis.
      echo "$hash:ISOLATE=1 yarn-project/kv-store/scripts/run_test.sh $test"
    elif under_any "$test" $node_dirs; then
      echo "$hash yarn-project/kv-store/scripts/run_test.sh $test"
    else
      echo "kv-store/bootstrap.sh: cannot classify $test." >&2
      echo "Add its directory to browser_dirs, node_dirs or unscheduled_dirs." >&2
      exit 1
    fi
  done
}

case "$cmd" in
  "")
    ;;
  *)
    default_cmd_handler "$@"
    ;;
esac
