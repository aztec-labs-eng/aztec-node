#!/usr/bin/env bash
"$(git rev-parse --show-toplevel)/bootstrap.sh" init || exit 1
source $(git rev-parse --show-toplevel)/ci3/source_bootstrap
source $root/yarn-project/scripts/echo_test_cmd.sh

repo_root=$(git rev-parse --show-toplevel)
export NARGO=${NARGO:-$repo_root/labs-aztec-toolchain/bin/nargo}
export BB=${BB:-$repo_root/labs-aztec-toolchain/bin/bb}
export PROFILER_PATH=${PROFILER_PATH:-$repo_root/labs-aztec-toolchain/bin/noir-profiler}

hash=$(../bootstrap.sh hash)

function test_cmds {
  # All CLI tests share test/mixed-workspace/target so they must run sequentially
  # in a single jest invocation (--runInBand is set by run_test.sh).
  echo_test_cmd unit "$hash:ISOLATE=1" aztec/cli src/cli \
    "NARGO=$NARGO BB=$BB PROFILER_PATH=$PROFILER_PATH yarn-project/scripts/run_test.sh aztec/src/cli"
  # setupLocalNetwork smoke test: spins up anvil + an in-process node (network usage ⇒ ISOLATE).
  echo_test_cmd unit "$hash:ISOLATE=1" aztec/testing src/testing/local-network.test.ts \
    "yarn-project/scripts/run_test.sh aztec/src/testing/local-network.test.ts"
  # Deploy framework tests: deploy.test.ts spins up anvil + an in-process node (network usage ⇒ ISOLATE).
  echo_test_cmd unit "$hash:ISOLATE=1" aztec/deploy src/deploy "yarn-project/scripts/run_test.sh aztec/src/deploy"
}

case "$cmd" in
  "")
    ;;
  *)
    default_cmd_handler "$@"
    ;;
esac
