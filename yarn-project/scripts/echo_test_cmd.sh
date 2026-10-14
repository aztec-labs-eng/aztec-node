# Sourced by the yarn-project, aztec and end-to-end bootstraps to echo each test command, together with any variants
# of it the test calls for. The only variant so far is a copy on an Amsterdam L1. Tests:
# yarn-project/scripts/echo_test_cmd.test.sh
#
# Usage: echo_test_cmd <unit|e2e> <prefix> <name> <test_path> <cmd>
#   prefix     the hash and its :K=V flags, without NAME.
#   name       the line's NAME, or empty for none.
#   test_path  the test file, or a directory of tests, as read from the cwd. It is only grepped for markers.
#   cmd        the command, echoed as given.
#
# Echoes "<prefix>[:NAME=<name>] <cmd>", then any variants.
#
# Amsterdam copy: when the test should also run on Amsterdam, the helper echoes
# "<prefix>:NAME=<name, or test_path when empty>_amsterdam ANVIL_HARDFORK=amsterdam <cmd>". startAnvil reads
# ANVIL_HARDFORK, and the suffixed NAME gives the copy its own docker container name. ANVIL_HARDFORK goes in the
# command rather than the :K=V prefix because ci3 prints results, keeps test history and posts GitHub statuses under
# the command alone, so a copy that differed only in its prefix would be indistinguishable from the original.
#
# A test is copied on every run when test_path (or any *.test.ts under it) calls describeAcrossL1Forks( on a line
# that does not start a //, /* or * comment. With CI_FULL=1 or HARDFORK_SWEEP=1 it is also copied, in unit mode, when it calls
# describeWithAnvil( and, in e2e mode, always: every simple e2e test starts anvil through setup(). Both markers come
# from @aztec-labs/ethereum/test.
#
# Never copied: e2e tests under single-node/l1-hardfork/, which switch L1 forks themselves, so move a simple e2e test
# there to keep it out of the sweep; and every test while DUMP_AVM_INPUTS_TO_DIR is set, as both runs would dump to
# one directory. Only simple e2e lines go through here: compose, ha, web3signer, cli-wallet flow and compat
# (CONTRACT_ARTIFACTS_VERSION) lines are echoed directly and never copied.

function l1_fork_test_has_marker {
  local marker=$1 test_path=$2
  grep -rqP --include='*.test.ts' "^(?!\s*(//|/?\*)).*\b$marker(\.(skip|only))?\s*\(" "$test_path" 2>/dev/null
}

function l1_fork_test_wants_amsterdam {
  local mode=$1 test_path=$2
  [ -z "${DUMP_AVM_INPUTS_TO_DIR:-}" ] || return 1
  if [ "$mode" = e2e ] && [[ "$test_path" == *single-node/l1-hardfork/* ]]; then
    return 1
  fi
  l1_fork_test_has_marker describeAcrossL1Forks "$test_path" && return 0
  [ "${CI_FULL:-0}" = 1 ] || [ "${HARDFORK_SWEEP:-0}" = 1 ] || return 1
  [ "$mode" = e2e ] || l1_fork_test_has_marker describeWithAnvil "$test_path"
}

function echo_test_cmd {
  local mode=$1 prefix=$2 name=$3 test_path=$4 cmd=$5
  echo "$prefix${name:+:NAME=$name} $cmd"
  if l1_fork_test_wants_amsterdam "$mode" "$test_path"; then
    echo "$prefix:NAME=${name:-$test_path}_amsterdam ANVIL_HARDFORK=amsterdam $cmd"
  fi
}
