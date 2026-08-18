#!/usr/bin/env bash
source $(git rev-parse --show-toplevel)/ci3/source_bootstrap

hash=$(../bootstrap.sh hash)
bench_fixtures_dir=chonk-pinned-flows
ultrahonk_bench_dir=ultrahonk-bench-inputs

# Per-test cache keys from yarn-project's dependency framework (../bootstrap.sh
# compute_test_dependencies, run as part of the yarn-project build). load_test_hashes loads
# the map once in the test_cmds shell; test_hash then runs inside $(...) subshells that
# inherit the map, so lookups spawn no per-test processes. The keys only matter to CI's redis
# test cache, so outside CI the map is not read at all — the empty-map fallback makes every
# lookup disabled-cache, as does any test absent from the map (it just runs uncached).
declare -A test_hashes
function load_test_hashes {
  [ "$CI" -eq 1 ] || return 0
  local t h
  while read -r t h; do test_hashes["$t"]=$h; done < <(../bootstrap.sh test_hashes)
}
function test_hash {
  echo "${test_hashes[end-to-end/$1]:-disabled-cache}"
}

function build {
  cache_load_image consensys/web3signer:25.11.0
  cache_load_image postgres:16-alpine
}

# Helper function to extract test names from a test file
function extract_test_names {
  local test_file="$1"
  grep -oP "(it|test)\s*\(\s*['\"].*?['\"]" "$test_file" | \
    sed -E "s/(it|test)\s*\(\s*['\"](.+)['\"]/\2/"
}

# Helper to generate DUMP_AVM_INPUTS_TO_DIR env var setting for a test (empty if not dumping)
function set_dump_avm {
  [ -n "${DUMP_AVM_INPUTS_TO_DIR:-}" ] && echo "DUMP_AVM_INPUTS_TO_DIR=${DUMP_AVM_INPUTS_TO_DIR}/$1"
}

function test_cmds {
  local run_test_script="yarn-project/end-to-end/scripts/run_test.sh"
  load_test_hashes
  local flags=":ISOLATE=1:TIMEOUT=20m"

  # On full CI we enable real proofs and allocate more resources to the e2e prover tests
  if [ "$CI_FULL" -eq 1 ]; then
    for test in src/single-node/prover/server/*.test.ts; do
      local name=${test#src/}
      name=${name%.test.ts}
      echo "$(test_hash "$test")$flags:TIMEOUT=20m:CPUS=16:MEM=96g:NAME=${name}_real $run_test_script simple ${test#src/}"
    done
    for test in src/single-node/prover/client/*.test.ts; do
      local name=${test#src/}
      name=${name%.test.ts}
      echo "$(test_hash "$test")$flags:TIMEOUT=10m:CPUS=2:MEM=4g:NAME=${name}_real $run_test_script simple ${test#src/}"
    done
  else
    for test in src/single-node/prover/**/*.test.ts; do
      local name=${test#src/}
      name=${name%.test.ts}
      echo "$(test_hash "$test")$flags:NAME=${name}_fake FAKE_PROOFS=1 $run_test_script simple ${test#src/}"
    done
  fi

  # Long-running avm_simulator
  echo "$(test_hash src/automine/simulation/avm_simulator.test.ts)$flags:TIMEOUT=30m:NAME=automine/simulation/avm_simulator $(set_dump_avm e2e_avm_simulator) $run_test_script simple src/automine/simulation/avm_simulator.test.ts"

  local tests=(
    # List all standalone and nested tests, except for the ones listed above.
    # Keep these globs non-overlapping: docker_isolate derives the container name from the test path, so a
    # duplicated path emits two sibling invocations racing on the same name — you'll see docker "Conflict,
    # name already in use" errors, or one copy's docker rm -f killing the other's live container mid-run.
    src/automine/*.test.ts
    src/automine/!(simulation)/**/*.test.ts
    src/automine/simulation/!(avm_simulator).test.ts
    src/single-node/!(prover)/**/*.test.ts
    src/infra/**/*.test.ts
    src/multi-node/**/*.test.ts
    src/p2p/**/*.test.ts
  )

  for test in "${tests[@]}"; do
    # Derive a CI test name from the path: drop the leading "src/" and trailing ".test.ts".
    # This keeps e2e_<dir>/<file> names while also handling the multi-node/ category folder.
    local name=${test#src/}
    name=${name%.test.ts}

    # Per-test bash TIMEOUT overrides — keep in sync with the test file's jest.setTimeout.
    local prefix="$(test_hash "$test")$flags"
    local test_prefix="$prefix"
    case "$name" in
      multi-node/governance/add_rollup)
        test_prefix="$prefix:TIMEOUT=20m"
        ;;
      single-node/cross-chain/l1_to_l2)
        # The duplicate-message scenario runs over private and public scope serially in one container.
        test_prefix="$prefix:TIMEOUT=25m"
        ;;
      single-node/cross-chain/l1_to_l2_inbox_drift)
        # The inbox-drift scenario runs over private and public scope serially in one container.
        test_prefix="$prefix:TIMEOUT=25m"
        ;;
      single-node/cross-chain/l2_to_l1)
        # Six message-shape / reorg its run serially in one container (was .parallel, one per it).
        test_prefix="$prefix:TIMEOUT=25m"
        ;;
      single-node/cross-chain/token_bridge)
        # Private + public round trips and the failure cases share one node and run serially.
        test_prefix="$prefix:TIMEOUT=25m"
        ;;
      single-node/block-building/block_building)
        # Block-building covers the full multi-tx / reorg surface and dumps AVM circuit inputs
        # (via set_dump_avm in the loop below) when DUMP_AVM_INPUTS_TO_DIR is set.
        test_prefix="$prefix:TIMEOUT=25m"
        ;;
      single-node/proving/long_proving_time)
        # The long-proving-time scenario waits out a multi-epoch prover delay.
        test_prefix="$prefix:TIMEOUT=15m"
        ;;
    esac

    # Check if this is a .parallel.test.ts file
    if [[ "$test" == *.parallel.test.ts ]]; then
      # Extract individual test names and create a command for each
      while IFS= read -r test_name; do
        # Create a safe name for the individual test. This becomes the docker container name via
        # docker_isolate, so every character outside docker's allowed set [a-zA-Z0-9_.-] (spaces,
        # parentheses, etc.) must be collapsed to an underscore or `docker run --name` rejects it.
        local safe_test_name=$(echo "$test_name" | sed 's/[^a-zA-Z0-9_.-]/_/g')
        local full_name="${name}_${safe_test_name}"
        echo "$test_prefix:NAME=$full_name $(set_dump_avm $full_name) $run_test_script simple $test \"$test_name\""
      done < <(extract_test_names "$test")
    else
      # Regular test file - run the whole file
      echo "$test_prefix:NAME=$name $(set_dump_avm $name) $run_test_script simple $test"
    fi
  done

  # compose-based tests (use running local network)
  tests=(
    # integration_proof_verification and e2e_persistence are excluded and run nowhere: the former's committed
    # epoch-proof fixture is stale (the proof no longer verifies), and the latter's beforeAll no longer
    # completes on the current branch (the single-node sequencer stalls in checkpoint proposal). See each
    # file's header comment. Both stay excluded until fixed/regenerated.
    src/composed/!(integration_proof_verification|e2e_persistence).test.ts
    src/guides/*.test.ts
  )
  for test in "${tests[@]}"; do
    # We must set ONLY_TERM_PARENT=1 to allow the script to fully control cleanup process.
    echo "$(test_hash "$test"):ONLY_TERM_PARENT=1:TIMEOUT=20m $run_test_script compose $test"
  done

  tests=(
    src/composed/web3signer/*.test.ts
  )
  for test in "${tests[@]}"; do
    # We must set ONLY_TERM_PARENT=1 to allow the script to fully control cleanup process.
    echo "$(test_hash "$test"):ONLY_TERM_PARENT=1:TIMEOUT=20m $run_test_script web3signer $test"
  done

  tests=(
    src/composed/ha/*.test.ts
  )
  for test in "${tests[@]}"; do
    # We must set ONLY_TERM_PARENT=1 to allow the script to fully control cleanup process.
    if [[ "$test" == *.parallel.test.ts ]]; then
      while IFS= read -r test_name; do
        echo "$(test_hash "$test"):ONLY_TERM_PARENT=1:TIMEOUT=30m $run_test_script ha $test \"$test_name\""
      done < <(extract_test_names "$test")
    else
      echo "$(test_hash "$test"):ONLY_TERM_PARENT=1:TIMEOUT=30m $run_test_script ha $test"
    fi
  done

  #echo "$hash:ONLY_TERM_PARENT=1 $run_test_script web3signer src/composed/web3signer/integration_remote_signer.test.ts"

  # compose-based tests with custom scripts
  for flow in ../cli-wallet/test/flows/*.sh; do
    # Note these scripts are ran directly by docker-compose.yml because it ends in '.sh'.
    # Run at LOG_LEVEL=verbose so the captured local-network logs are detailed enough for diagnostics.
    echo "$hash:ONLY_TERM_PARENT=1 LOG_LEVEL=verbose $run_test_script compose $flow"
  done
}

function test {
  echo_header "e2e tests"
  test_cmds | filter_test_cmds | parallelize
}

function bench_cmds {
  echo "$hash:ISOLATE=1:NAME=bench_build_block BENCH_OUTPUT=bench-out/build-block.bench.json yarn-project/end-to-end/scripts/run_test.sh simple bench_build_block"
  echo "$hash:ISOLATE=1:CPUS=8:NAME=tx_stats BB_IVC_CONCURRENCY=1 BB_NUM_IVC_VERIFIERS=8 BENCH_OUTPUT=bench-out/tx_stats.bench.json yarn-project/end-to-end/scripts/run_test.sh simple tx_stats_bench"
  echo "$hash:ISOLATE=1:NAME=node_rpc_perf BENCH_OUTPUT=bench-out/node_rpc_perf.bench.json yarn-project/end-to-end/scripts/run_test.sh simple node_rpc_perf"
  for client_flow in client_flows/bridging client_flows/deployments client_flows/amm client_flows/account_deployments client_flows/transfers client_flows/storage_proof; do
    echo "$hash:ISOLATE=1:CPUS=8:NAME=$client_flow BENCHMARK_CONFIG=key_flows LOG_LEVEL=error BENCH_OUTPUT=bench-out/ yarn-project/end-to-end/scripts/run_test.sh simple $client_flow"
  done
}

# Live-capture Chonk IVC inputs from the e2e stack into $bench_fixtures_dir.
# Slow: used only when explicitly refreshing the pinned tarball.
function build_bench_capture {
  export CAPTURE_IVC_FOLDER=${CAPTURE_IVC_FOLDER:-$bench_fixtures_dir}
  export BENCHMARK_CONFIG=key_flows
  export LOG_LEVEL=error
  export ENV_VARS_TO_INJECT="BENCHMARK_CONFIG CAPTURE_IVC_FOLDER LOG_LEVEL"
  rm -rf "$CAPTURE_IVC_FOLDER" && mkdir -p "$CAPTURE_IVC_FOLDER"
  parallel --tag --line-buffer --halt now,fail=1 'docker_isolate "scripts/run_test.sh simple {}"' ::: \
    client_flows/account_deployments \
    client_flows/deployments \
    client_flows/bridging \
    client_flows/transfers \
    client_flows/amm \
    client_flows/storage_proof
}

# Builds benchmark fixtures that are still owned by yarn-project.
# Chonk benchmark inputs are pinned and downloaded via labs-aztec-toolchain.
function build_bench {
  rm -rf bench-out && mkdir -p bench-out

  rm -rf "$ultrahonk_bench_dir" && mkdir -p "$ultrahonk_bench_dir"
  if ! cache_download "bb-ultrahonk-bench-inputs-$hash.tar.gz"; then
    export BASE_PARITY_BENCH_DIR="$(pwd)/$ultrahonk_bench_dir"
    yarn workspace @aztec/ivc-integration test src/base_parity_inputs.test.ts
    cache_upload "bb-ultrahonk-bench-inputs-$hash.tar.gz" "$ultrahonk_bench_dir"
  fi
}

function bench {
  rm -rf bench-out
  mkdir -p bench-out
  bench_cmds | STRICT_SCHEDULING=1 parallelize
}

# Generates e2e test commands using contract artifacts from a prior release version.
# Only includes simple (jest-based) tests since compose/docker tests don't use the legacy jest resolver.
# Excludes kernelless_simulation, which asserts on the exact number of nullifiers emitted and breaks
# whenever contracts add/remove nullifier emissions across versions (unrelated to the compat contract
# surface).
function compat_test_cmds {
  local version=${1:?version is required}
  local run_test_script="yarn-project/end-to-end/scripts/run_test.sh"
  local prefix="$hash:ISOLATE=1"
  local compat_env="CONTRACT_ARTIFACTS_VERSION=$version"

  local tests=(
    src/automine/*.test.ts
    src/automine/contracts/*.test.ts
    src/automine/contracts/deploy/*.test.ts
    src/automine/contracts/nested/*.test.ts
    src/automine/token/*.test.ts
    src/automine/accounts/*.test.ts
    src/automine/effects/*.test.ts
    src/automine/simulation/!(kernelless_simulation).test.ts
    src/single-node/fees/*.test.ts
    src/single-node/cross-chain/*.test.ts
    src/single-node/bot/*.test.ts
    src/infra/*.test.ts
    src/p2p/*.test.ts
    src/p2p/reqresp/*.test.ts
  )
  for test in "${tests[@]}"; do
    local name
    if [[ "$test" == src/p2p/* || "$test" == src/automine/* ]]; then
      # The p2p/ and automine/ folders have no `e2e_` prefix to strip; flatten their path into an
      # e2e_<path> name (matching the historical e2e_p2p/<file> names) by dropping "src/", ".test.ts",
      # and slashes.
      name=${test#src/}
      name=e2e_${name%.test.ts}
      name=${name//\//_}
    else
      name=${test#*e2e_}
      name=e2e_${name%.test.ts}
    fi

    if [[ "$test" == *.parallel.test.ts ]]; then
      while IFS= read -r test_name; do
        # See the matching note in test_cmds: collapse docker-illegal characters so NAME is a valid
        # container name for docker_isolate.
        local safe_test_name=$(echo "$test_name" | sed 's/[^a-zA-Z0-9_.-]/_/g')
        local full_name="compat_${version}_${name}_${safe_test_name}"
        echo "$prefix:NAME=$full_name $compat_env $run_test_script simple $test \"$test_name\""
      done < <(extract_test_names "$test")
    else
      echo "$prefix:NAME=compat_${version}_${name} $compat_env $run_test_script simple $test"
    fi
  done
}

case "$cmd" in
  "")
    build
    ;;
  *)
    default_cmd_handler "$@"
    ;;
esac
