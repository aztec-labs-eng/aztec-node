#!/usr/bin/env bash
# Tests for echo_test_cmd.sh. Run: yarn-project/scripts/echo_test_cmd.test.sh
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/echo_test_cmd.sh"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
cd "$root"

passed=0
failed=0

# Usage: check <description> <expected lines> <echo_test_cmd args...>, with CI_FULL, HARDFORK_SWEEP and
# DUMP_AVM_INPUTS_TO_DIR from the env.
function check {
  local description=$1 expected=$2 actual
  shift 2
  actual=$(echo_test_cmd "$@")
  if [ "$actual" == "$expected" ]; then
    echo "  ok: $description"
    ((++passed))
  else
    echo "  FAIL: $description"
    diff <(echo "$expected") <(echo "$actual") | sed 's/^/    /' || true
    ((++failed))
  fi
}

function fixture {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}

fixture pkg/across.test.ts $'import { describeAcrossL1Forks } from \'@aztec-labs/ethereum/test\';\n\ndescribeAcrossL1Forks(\'x\', () => {});'
fixture pkg/across_only.test.ts "describeAcrossL1Forks.only ('x', () => {});"
fixture pkg/anvil.test.ts "  describeWithAnvil('x', () => {});"
fixture pkg/plain.test.ts "describe('x', () => { startAnvil(); });"
fixture pkg/commented.test.ts $'// describeAcrossL1Forks(\'x\', () => {});\n * describeWithAnvil(\'x\')\n/** describeAcrossL1Forks(\'x\') */\ndescribe(\'x\', () => {});'
fixture pkg/imported_only.test.ts "import { describeAcrossL1Forks } from '@aztec-labs/ethereum/test';"
fixture dir/a.test.ts "describe('x', () => {});"
fixture dir/b.test.ts "describeWithAnvil('x', () => {});"
fixture dir/helper.ts "describeAcrossL1Forks('x', () => {});"
fixture e2e/src/single-node/plain.test.ts "describe('x', () => {});"
fixture e2e/src/single-node/l1-hardfork/switch.test.ts "describeAcrossL1Forks('x', () => {});"

run=yarn-project/scripts/run_test.sh
e2e=yarn-project/end-to-end/scripts/run_test.sh
unset CI_FULL HARDFORK_SWEEP DUMP_AVM_INPUTS_TO_DIR

echo "every run"
check "describeAcrossL1Forks gets an Amsterdam copy with a suffixed NAME" \
"h:ISOLATE=1:NAME=pkg/across.test.ts $run pkg/across.test.ts
h:ISOLATE=1:NAME=pkg/across.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run pkg/across.test.ts" \
  unit h:ISOLATE=1 pkg/across.test.ts pkg/across.test.ts "$run pkg/across.test.ts"
check "a line without NAME gets one on its copy only" \
"h $run pkg/across.test.ts
h:NAME=pkg/across.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run pkg/across.test.ts" \
  unit h "" pkg/across.test.ts "$run pkg/across.test.ts"
check "the command is kept verbatim, env assignments and quotes included" \
"h:CPUS=8:NAME=n LOG_LEVEL=\"debug; info: json-rpc\" $run pkg/across.test.ts \"it's\"
h:CPUS=8:NAME=n_amsterdam ANVIL_HARDFORK=amsterdam LOG_LEVEL=\"debug; info: json-rpc\" $run pkg/across.test.ts \"it's\"" \
  unit h:CPUS=8 n pkg/across.test.ts "LOG_LEVEL=\"debug; info: json-rpc\" $run pkg/across.test.ts \"it's\""
check "describeAcrossL1Forks.only still marks the file" \
"h $run x
h:NAME=pkg/across_only.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run x" \
  unit h "" pkg/across_only.test.ts "$run x"
check "describeWithAnvil is not copied outside the sweep" "h $run x" unit h "" pkg/anvil.test.ts "$run x"
check "an unmarked file is not copied" "h $run x" unit h "" pkg/plain.test.ts "$run x"
check "commented-out markers are ignored" "h $run x" unit h "" pkg/commented.test.ts "$run x"
check "an import alone does not mark the file" "h $run x" unit h "" pkg/imported_only.test.ts "$run x"
check "a missing file is not copied" "h $run x" unit h "" pkg/missing.test.ts "$run x"
check "an unmarked simple e2e test is not copied" \
  "h:NAME=single-node/plain  $e2e simple src/single-node/plain.test.ts" \
  e2e h single-node/plain src/single-node/plain.test.ts " $e2e simple src/single-node/plain.test.ts"

echo "full CI sweep"
for sweep_var in CI_FULL HARDFORK_SWEEP; do
  export $sweep_var=1
  check "$sweep_var=1 copies a describeWithAnvil file" \
"h $run x
h:NAME=pkg/anvil.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run x" \
    unit h "" pkg/anvil.test.ts "$run x"
  check "$sweep_var=1 copies a describeAcrossL1Forks file once" \
"h $run x
h:NAME=pkg/across.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run x" \
    unit h "" pkg/across.test.ts "$run x"
  check "$sweep_var=1 leaves an unmarked unit test alone" "h $run x" unit h "" pkg/plain.test.ts "$run x"
  check "$sweep_var=1 copies an unmarked simple e2e test" \
"h:NAME=single-node/plain  $e2e simple src/single-node/plain.test.ts
h:NAME=single-node/plain_amsterdam ANVIL_HARDFORK=amsterdam  $e2e simple src/single-node/plain.test.ts" \
    e2e h single-node/plain src/single-node/plain.test.ts " $e2e simple src/single-node/plain.test.ts"
  unset $sweep_var
done

export CI_FULL=1
check "e2e tests under single-node/l1-hardfork/ are never copied" \
  "h:NAME=l1-hardfork/switch $e2e simple src/single-node/l1-hardfork/switch.test.ts" \
  e2e h l1-hardfork/switch src/single-node/l1-hardfork/switch.test.ts "$e2e simple src/single-node/l1-hardfork/switch.test.ts"
check "a directory is copied when any test file in it is marked" \
"h:NAME=dir $run dir
h:NAME=dir_amsterdam ANVIL_HARDFORK=amsterdam $run dir" \
  unit h dir dir "$run dir"
unset CI_FULL
check "a marker in a non-test file of a directory does not count" "h:NAME=dir $run dir" unit h dir dir "$run dir"

export CI_FULL=1 DUMP_AVM_INPUTS_TO_DIR=/tmp/avm
check "nothing is copied while dumping AVM inputs" \
  "h:NAME=n DUMP_AVM_INPUTS_TO_DIR=/tmp/avm/n $e2e simple src/single-node/plain.test.ts" \
  e2e h n src/single-node/plain.test.ts "DUMP_AVM_INPUTS_TO_DIR=/tmp/avm/n $e2e simple src/single-node/plain.test.ts"
check "nothing is copied while dumping AVM inputs, even when marked across forks" "h $run x" \
  unit h "" pkg/across.test.ts "$run x"
unset CI_FULL DUMP_AVM_INPUTS_TO_DIR

echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
