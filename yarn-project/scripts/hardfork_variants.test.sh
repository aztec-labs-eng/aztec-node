#!/usr/bin/env bash
# Tests for hardfork_variants.sh. Run: yarn-project/scripts/hardfork_variants.test.sh
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
filter=$script_dir/hardfork_variants.sh
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

passed=0
failed=0

# Runs the filter on the input lines and compares its output with the expected lines.
# Usage: check <name> <mode> <expected> <input>, with CI_FULL, HARDFORK_SWEEP, DUMP_AVM_INPUTS_TO_DIR from the env,
# run from the directory in $cwd when set.
function check {
  local name=$1 mode=$2 expected=$3 input=$4 actual
  actual=$(cd "${cwd:-.}" && printf '%s\n' "$input" | "$filter" "$mode" "$root/$mode")
  if [ "$actual" == "$expected" ]; then
    echo "  ok: $name"
    ((++passed))
  else
    echo "  FAIL: $name"
    diff <(echo "$expected") <(echo "$actual") | sed 's/^/    /' || true
    ((++failed))
  fi
}

function fixture {
  mkdir -p "$(dirname "$root/$1")"
  printf '%s\n' "$2" >"$root/$1"
}

tagged=$'import { runOnAllL1Forks } from \'@aztec-labs/ethereum/test\';\n\nrunOnAllL1Forks();\n'
fixture unit/ethereum/src/tagged.test.ts "$tagged"
fixture unit/ethereum/src/anvil.test.ts 'const { rpcUrl } = await startAnvil({ port: 0 });'
fixture unit/ethereum/src/pure.test.ts 'expect(1).toBe(1);'
fixture unit/ethereum/src/commented.test.ts $'// runOnAllL1Forks();\n * runOnAllL1Forks()\nconst { rpcUrl } = await startAnvil();'
fixture unit/ethereum/src/spaced.test.ts 'runOnAllL1Forks ();'
fixture unit/ethereum/src/test/start_anvil.test.ts $'runOnAllL1Forks();\nstartAnvil();'
fixture unit/aztec/src/testing/local-network.test.ts "$tagged"
fixture e2e/src/single-node/tagged.test.ts "$tagged"
fixture e2e/src/single-node/plain.test.ts 'await setup();'
fixture e2e/src/single-node/many.parallel.test.ts "$tagged"
fixture e2e/src/single-node/prover/full.test.ts "$tagged"
fixture e2e/src/single-node/l1-hardfork/transition.test.ts "$tagged"
fixture e2e/src/composed/tagged_compose.test.ts "$tagged"

run_unit=yarn-project/scripts/run_test.sh
run_e2e=yarn-project/end-to-end/scripts/run_test.sh

echo "unit mode"
unset CI_FULL HARDFORK_SWEEP DUMP_AVM_INPUTS_TO_DIR

check "tagged isolated line gets a suffixed NAME and the fork in its command" unit \
"h1:ISOLATE=1:NAME=ethereum/src/tagged.test.ts $run_unit ethereum/src/tagged.test.ts
h1:ISOLATE=1:NAME=ethereum/src/tagged.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run_unit ethereum/src/tagged.test.ts" \
"h1:ISOLATE=1:NAME=ethereum/src/tagged.test.ts $run_unit ethereum/src/tagged.test.ts"

check "tagged line without NAME gets one" unit \
"h1 $run_unit ethereum/src/tagged.test.ts
h1:NAME=tagged.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run_unit ethereum/src/tagged.test.ts" \
"h1 $run_unit ethereum/src/tagged.test.ts"

check "existing env assignments, quoted values and other prefix fields are kept" unit \
"h1:ISOLATE=1:CPUS=8:NAME=ethereum/src/tagged.test.ts LOG_LEVEL=\"debug; info: json-rpc\" FAKE_PROOFS=1 $run_unit ethereum/src/tagged.test.ts
h1:ISOLATE=1:CPUS=8:NAME=ethereum/src/tagged.test.ts_amsterdam ANVIL_HARDFORK=amsterdam LOG_LEVEL=\"debug; info: json-rpc\" FAKE_PROOFS=1 $run_unit ethereum/src/tagged.test.ts" \
"h1:ISOLATE=1:CPUS=8:NAME=ethereum/src/tagged.test.ts LOG_LEVEL=\"debug; info: json-rpc\" FAKE_PROOFS=1 $run_unit ethereum/src/tagged.test.ts"

check "every duplicated NAME field gets the suffix" unit \
"h1:NAME=a:TIMEOUT=5m:NAME=b $run_unit ethereum/src/tagged.test.ts
h1:NAME=a_amsterdam:TIMEOUT=5m:NAME=b_amsterdam ANVIL_HARDFORK=amsterdam $run_unit ethereum/src/tagged.test.ts" \
"h1:NAME=a:TIMEOUT=5m:NAME=b $run_unit ethereum/src/tagged.test.ts"

check "untagged anvil, pure, commented-out and missing files pass through" unit \
"h1 $run_unit ethereum/src/anvil.test.ts
h1 $run_unit ethereum/src/pure.test.ts
h1 $run_unit ethereum/src/commented.test.ts
h1 $run_unit ethereum/src/missing.test.ts
h1 $run_unit aztec/src/cli" \
"h1 $run_unit ethereum/src/anvil.test.ts
h1 $run_unit ethereum/src/pure.test.ts
h1 $run_unit ethereum/src/commented.test.ts
h1 $run_unit ethereum/src/missing.test.ts
h1 $run_unit aztec/src/cli"

check "whitespace before the call still tags" unit \
"h1 $run_unit ethereum/src/spaced.test.ts
h1:NAME=spaced.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run_unit ethereum/src/spaced.test.ts" \
"h1 $run_unit ethereum/src/spaced.test.ts"

cwd=$root/unit/aztec check "paths resolve against the component root, not the cwd" unit \
"h1:ISOLATE=1:NAME=aztec/testing $run_unit aztec/src/testing/local-network.test.ts
h1:ISOLATE=1:NAME=aztec/testing_amsterdam ANVIL_HARDFORK=amsterdam $run_unit aztec/src/testing/local-network.test.ts" \
"h1:ISOLATE=1:NAME=aztec/testing $run_unit aztec/src/testing/local-network.test.ts"

check "lines that already pick a fork or replay compat artifacts pass through" unit \
"h1 ANVIL_HARDFORK=osaka $run_unit ethereum/src/tagged.test.ts
h1 CONTRACT_ARTIFACTS_VERSION=4.0.0 $run_unit ethereum/src/tagged.test.ts" \
"h1 ANVIL_HARDFORK=osaka $run_unit ethereum/src/tagged.test.ts
h1 CONTRACT_ARTIFACTS_VERSION=4.0.0 $run_unit ethereum/src/tagged.test.ts"

check "start_anvil.test.ts is never copied" unit \
"h1 $run_unit ethereum/src/test/start_anvil.test.ts" \
"h1 $run_unit ethereum/src/test/start_anvil.test.ts"

echo "unit mode, sweep"
for sweep_var in CI_FULL HARDFORK_SWEEP; do
  export $sweep_var=1
  check "$sweep_var=1 also copies direct startAnvil callers, once each" unit \
"h1 $run_unit ethereum/src/anvil.test.ts
h1:NAME=anvil.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run_unit ethereum/src/anvil.test.ts
h1 $run_unit ethereum/src/commented.test.ts
h1:NAME=commented.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run_unit ethereum/src/commented.test.ts
h1 $run_unit ethereum/src/tagged.test.ts
h1:NAME=tagged.test.ts_amsterdam ANVIL_HARDFORK=amsterdam $run_unit ethereum/src/tagged.test.ts
h1 $run_unit ethereum/src/pure.test.ts
h1 $run_unit ethereum/src/test/start_anvil.test.ts" \
"h1 $run_unit ethereum/src/anvil.test.ts
h1 $run_unit ethereum/src/commented.test.ts
h1 $run_unit ethereum/src/tagged.test.ts
h1 $run_unit ethereum/src/pure.test.ts
h1 $run_unit ethereum/src/test/start_anvil.test.ts"
  unset $sweep_var
done

echo "e2e mode"

check "tagged simple line keeps the double space left by an empty set_dump_avm" e2e \
"h2:ISOLATE=1:TIMEOUT=20m:NAME=single-node/tagged  $run_e2e simple src/single-node/tagged.test.ts
h2:ISOLATE=1:TIMEOUT=20m:NAME=single-node/tagged_amsterdam ANVIL_HARDFORK=amsterdam  $run_e2e simple src/single-node/tagged.test.ts" \
"h2:ISOLATE=1:TIMEOUT=20m:NAME=single-node/tagged  $run_e2e simple src/single-node/tagged.test.ts"

check "parallel fan-out lines keep their quoted test names" e2e \
"h2:ISOLATE=1:NAME=single-node/many_does_a_thing  $run_e2e simple src/single-node/many.parallel.test.ts \"does a thing\"
h2:ISOLATE=1:NAME=single-node/many_does_a_thing_amsterdam ANVIL_HARDFORK=amsterdam  $run_e2e simple src/single-node/many.parallel.test.ts \"does a thing\"
h2:ISOLATE=1:NAME=single-node/many_it_s__quoted_  $run_e2e simple src/single-node/many.parallel.test.ts \"it's 'quoted'\"
h2:ISOLATE=1:NAME=single-node/many_it_s__quoted__amsterdam ANVIL_HARDFORK=amsterdam  $run_e2e simple src/single-node/many.parallel.test.ts \"it's 'quoted'\"" \
"h2:ISOLATE=1:NAME=single-node/many_does_a_thing  $run_e2e simple src/single-node/many.parallel.test.ts \"does a thing\"
h2:ISOLATE=1:NAME=single-node/many_it_s__quoted_  $run_e2e simple src/single-node/many.parallel.test.ts \"it's 'quoted'\""

check "prover lines resolve their src-relative path" e2e \
"h2:ISOLATE=1:TIMEOUT=20m:NAME=single-node/prover/full_fake FAKE_PROOFS=1 $run_e2e simple single-node/prover/full.test.ts
h2:ISOLATE=1:TIMEOUT=20m:NAME=single-node/prover/full_fake_amsterdam ANVIL_HARDFORK=amsterdam FAKE_PROOFS=1 $run_e2e simple single-node/prover/full.test.ts" \
"h2:ISOLATE=1:TIMEOUT=20m:NAME=single-node/prover/full_fake FAKE_PROOFS=1 $run_e2e simple single-node/prover/full.test.ts"

check "untagged, fork-switching, compose and flow lines pass through" e2e \
"h2:ISOLATE=1:NAME=single-node/plain  $run_e2e simple src/single-node/plain.test.ts
h2:ISOLATE=1:NAME=single-node/l1-hardfork/transition  $run_e2e simple src/single-node/l1-hardfork/transition.test.ts
h2:ONLY_TERM_PARENT=1:TIMEOUT=20m $run_e2e compose src/composed/tagged_compose.test.ts
h2:ONLY_TERM_PARENT=1 LOG_LEVEL=verbose $run_e2e compose ../cli-wallet/test/flows/basic.sh" \
"h2:ISOLATE=1:NAME=single-node/plain  $run_e2e simple src/single-node/plain.test.ts
h2:ISOLATE=1:NAME=single-node/l1-hardfork/transition  $run_e2e simple src/single-node/l1-hardfork/transition.test.ts
h2:ONLY_TERM_PARENT=1:TIMEOUT=20m $run_e2e compose src/composed/tagged_compose.test.ts
h2:ONLY_TERM_PARENT=1 LOG_LEVEL=verbose $run_e2e compose ../cli-wallet/test/flows/basic.sh"

echo "e2e mode, sweep"
export CI_FULL=1
check "CI_FULL=1 copies every simple line except fork-switching and compat ones" e2e \
"h2:ISOLATE=1:NAME=single-node/plain  $run_e2e simple src/single-node/plain.test.ts
h2:ISOLATE=1:NAME=single-node/plain_amsterdam ANVIL_HARDFORK=amsterdam  $run_e2e simple src/single-node/plain.test.ts
h2:ISOLATE=1:NAME=single-node/l1-hardfork/transition  $run_e2e simple src/single-node/l1-hardfork/transition.test.ts
h2:ISOLATE=1:NAME=compat_4.0.0_plain CONTRACT_ARTIFACTS_VERSION=4.0.0 $run_e2e simple src/single-node/plain.test.ts
h2:ONLY_TERM_PARENT=1:TIMEOUT=20m $run_e2e compose src/composed/tagged_compose.test.ts" \
"h2:ISOLATE=1:NAME=single-node/plain  $run_e2e simple src/single-node/plain.test.ts
h2:ISOLATE=1:NAME=single-node/l1-hardfork/transition  $run_e2e simple src/single-node/l1-hardfork/transition.test.ts
h2:ISOLATE=1:NAME=compat_4.0.0_plain CONTRACT_ARTIFACTS_VERSION=4.0.0 $run_e2e simple src/single-node/plain.test.ts
h2:ONLY_TERM_PARENT=1:TIMEOUT=20m $run_e2e compose src/composed/tagged_compose.test.ts"

export DUMP_AVM_INPUTS_TO_DIR=/tmp/avm
check "no copies at all while dumping AVM inputs" e2e \
"h2:ISOLATE=1:NAME=single-node/tagged DUMP_AVM_INPUTS_TO_DIR=/tmp/avm/single-node/tagged $run_e2e simple src/single-node/tagged.test.ts" \
"h2:ISOLATE=1:NAME=single-node/tagged DUMP_AVM_INPUTS_TO_DIR=/tmp/avm/single-node/tagged $run_e2e simple src/single-node/tagged.test.ts"
unset CI_FULL DUMP_AVM_INPUTS_TO_DIR

echo "flake retry"
# run_test_cmd exports NAME_POSTFIX on a retry; a copy must not set it in its command, or it would override that.
retry_out=$(printf '%s\n' "h2:ISOLATE=1:NAME=single-node/tagged  $run_e2e simple src/single-node/tagged.test.ts" |
  "$filter" e2e "$root/e2e")
if [[ "$retry_out" == *NAME_POSTFIX* ]]; then
  echo "  FAIL: copies leave NAME_POSTFIX to the retry logic"
  ((++failed))
else
  echo "  ok: copies leave NAME_POSTFIX to the retry logic"
  ((++passed))
fi

echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
