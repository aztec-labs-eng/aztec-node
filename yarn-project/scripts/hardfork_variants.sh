#!/usr/bin/env bash
# Usage: <test cmds on stdin> | hardfork_variants.sh <unit|e2e> [component root]
#
# Re-echoes every test command line. After each line whose test should also run against an Amsterdam L1, it echoes a
# copy with ANVIL_HARDFORK=amsterdam before the command and _amsterdam appended to NAME (or :NAME=<file>_amsterdam
# added when the line has none). The copy gets its own docker container name, and its own test-cache key, since the
# key is the hash of the whole line. startAnvil reads ANVIL_HARDFORK. It goes in the command, not the :K=V prefix,
# because docker_isolate does not forward prefix vars into the container.
#
# A test qualifies on every run when its file calls runOnAllL1Forks() (from @aztec-labs/ethereum/test) on a line that
# is not a comment. With CI_FULL=1 or HARDFORK_SWEEP=1, every test that starts anvil qualifies too: in e2e mode every
# simple-runner test, in unit mode every file that calls startAnvil( itself.
#
# Never copied: lines already setting ANVIL_HARDFORK (the test picks its fork), lines setting
# CONTRACT_ARTIFACTS_VERSION (compat runs replay L2 artifacts and add no L1 coverage), tests under
# single-node/l1-hardfork/ (they switch forks themselves) and ethereum/src/test/start_anvil.test.ts (it swaps in fake
# anvil binaries). Nothing is copied while DUMP_AVM_INPUTS_TO_DIR is set, as both runs would dump to one directory.
#
# Test paths resolve against the component that emitted the lines: yarn-project for unit, yarn-project/end-to-end for
# e2e, where a path may also be relative to jest's rootDir (src/), as the prover test lines are.
#
# Tests: yarn-project/scripts/hardfork_variants.test.sh
set -euo pipefail

mode=${1:?usage: hardfork_variants.sh <unit|e2e> [component root]}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fork=amsterdam

case "$mode" in
  unit)
    root=${2:-$(dirname "$script_dir")}
    test_re='yarn-project/scripts/run_test\.sh ([^ ]+\.test\.ts)'
    ;;
  e2e)
    root=${2:-$(dirname "$script_dir")/end-to-end}
    test_re='yarn-project/end-to-end/scripts/run_test\.sh simple ([^ ]+\.test\.ts)'
    ;;
  *)
    echo "hardfork_variants.sh: unknown mode '$mode', expected unit or e2e" >&2
    exit 1
    ;;
esac

if [ -n "${DUMP_AVM_INPUTS_TO_DIR:-}" ]; then
  exec cat
fi

sweep=0
if [ "${CI_FULL:-0}" = 1 ] || [ "${HARDFORK_SWEEP:-0}" = 1 ]; then
  sweep=1
fi

function resolve_test_file {
  local file=$1
  if [ -f "$root/$file" ]; then
    echo "$root/$file"
  elif [ "$mode" = e2e ] && [ -f "$root/src/$file" ]; then
    echo "$root/src/$file"
  fi
}

function is_excluded {
  case "$1" in
    */single-node/l1-hardfork/* | */ethereum/src/test/start_anvil.test.ts) return 0 ;;
    *) return 1 ;;
  esac
}

function is_tagged {
  grep -qP '^(?!\s*(//|\*)).*\brunOnAllL1Forks\s*\(' "$1"
}

function starts_anvil {
  case "$mode" in
    e2e) return 0 ;;
    unit) grep -q 'startAnvil(' "$1" ;;
  esac
}

declare -A verdicts
function wants_variant {
  local file=$1 path
  if [ -z "${verdicts[$file]:-}" ]; then
    verdicts[$file]=0
    path=$(resolve_test_file "$file")
    if [ -n "$path" ] && ! is_excluded "$path"; then
      if is_tagged "$path" || { [ "$sweep" = 1 ] && starts_anvil "$path"; }; then
        verdicts[$file]=1
      fi
    fi
  fi
  [ "${verdicts[$file]}" = 1 ]
}

while IFS= read -r line || [ -n "$line" ]; do
  printf '%s\n' "$line"
  prefix=${line%% *}
  cmd=${line#* }
  [[ "$cmd" == *ANVIL_HARDFORK=* || "$cmd" == *CONTRACT_ARTIFACTS_VERSION=* ]] && continue
  [[ "$cmd" =~ $test_re ]] || continue
  file=${BASH_REMATCH[1]}
  wants_variant "$file" || continue

  # Suffix every NAME field: source_test_params exports them in order, so whichever one wins carries the suffix.
  IFS=: read -ra fields <<<"$prefix"
  variant_prefix=${fields[0]}
  has_name=0
  for field in "${fields[@]:1}"; do
    if [[ "$field" == NAME=* ]]; then
      field="${field}_$fork"
      has_name=1
    fi
    variant_prefix+=":$field"
  done
  [ "$has_name" = 1 ] || variant_prefix+=":NAME=$(basename "$file")_$fork"

  printf '%s\n' "$variant_prefix ANVIL_HARDFORK=$fork $cmd"
done
