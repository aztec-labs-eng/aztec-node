#!/usr/bin/env bash
set -euo pipefail

# Re-execute using correct version if we have an .aztecrc file.
if [ "${AZTEC_VERSIONED:-0}" -eq 0 ] && [ -f .aztecrc ] && command -v aztec-up &>/dev/null; then
  env_setup=$(aztec-up env)
  eval "$env_setup"
  AZTEC_VERSIONED=1 exec aztec "$@"
fi

cmd=${1:-}
[ -n "$cmd" ] && shift

script_dir="$(dirname "$(realpath "$0")")"

function aztec {
  export AZTEC_SHELL_WRAPPER=1
  exec node --no-warnings $script_dir/../dest/bin/index.js "$@"
}

case $cmd in
  test)
    txe_port=8081
    # Attempt to compile, no-op if there are no changes
    node --no-warnings "$script_dir/../dest/bin/index.js" compile

    export LOG_LEVEL="${LOG_LEVEL:-"error;trace:^contract:"}"
    if ! command -v nc &>/dev/null; then
      echo "Error: 'nc' (netcat) is required but not installed." >&2
      exit 1
    fi
    # The readiness check below cannot tell our TXE apart from another server on the port.
    if nc -z 127.0.0.1 "$txe_port" &>/dev/null; then
      echo "Error: port $txe_port is already in use, so the TXE cannot listen on it. Stop the process holding it and retry." >&2
      exit 1
    fi
    # The TXE runs alongside nargo, and by default both would write to the same stdout and stderr. When those are pipes,
    # Node switches them to non-blocking mode, and every process holding the pipe shares that mode, so nargo's writes
    # would become non-blocking too. A non-blocking write to a full pipe fails instead of waiting for the reader to
    # drain it, and nargo exits with an error when a write fails, so a reader slower than nargo's output (a log
    # collector, a pager) would make `aztec test` crash partway through. Giving the TXE pipes of its own, relayed by
    # `cat`, confines the non-blocking mode to them. Terminals need no relay: Node opens its own handle to a terminal
    # rather than changing the shared one, and a relay would hide the terminal from the TXE and turn off its colors.
    (
      if ! [ -t 1 ]; then exec > >(cat); fi
      if ! [ -t 2 ]; then exec 2> >(cat >&2); fi
      aztec start --txe --port "$txe_port"
    ) &
    server_pid=$!
    trap 'kill $server_pid &>/dev/null || true' EXIT
    while ! nc -z 127.0.0.1 "$txe_port" &>/dev/null; do
      if ! kill -0 $server_pid 2>/dev/null; then
        txe_status=0
        wait $server_pid || txe_status=$?
        echo "Error: the TXE exited with status $txe_status before listening on port $txe_port." >&2
        exit 1
      fi
      sleep 0.2
    done
    export NARGO_FOREIGN_CALL_TIMEOUT=300000
    nargo test --silence-warnings --oracle-resolver "http://127.0.0.1:$txe_port" "$@"
    ;;
  start)
    if [ "${1:-}" == "--local-network" ]; then
      # TODO: Can these just be set in TS?
      export ARCHIVER_POLLING_INTERVAL_MS=500
      export P2P_BLOCK_CHECK_INTERVAL_MS=500
      export SEQ_TX_POLLING_INTERVAL_MS=500
      export WS_BLOCK_CHECK_INTERVAL_MS=500
      export ARCHIVER_VIEM_POLLING_INTERVAL_MS=500
      export TEST_ACCOUNTS=${TEST_ACCOUNTS:-true}
      export LOG_LEVEL=${LOG_LEVEL:-info;silent:sequencer;verbose:debug_log}
      export DEPLOY_AZTEC_CONTRACTS_SALT=${DEPLOY_AZTEC_CONTRACTS_SALT:-$RANDOM}

      ANVIL_PORT=${ANVIL_PORT:-8545}

      export L1_CHAIN_ID=${L1_CHAIN_ID:-31337}
      export ETHEREUM_HOSTS=${ETHEREUM_HOSTS:-"http://127.0.0.1:${ANVIL_PORT}"}

      anvil --version
      anvil --silent --port "$ANVIL_PORT" &
      anvil_pid=$!
      trap 'kill $anvil_pid &>/dev/null' EXIT
    fi

    aztec start "$@"
    ;;
  new|init)
    $script_dir/${cmd}.sh "$@"
    ;;
  flamegraph)
    echo "Warning: 'aztec flamegraph' is deprecated. Use 'aztec profile flamegraph' instead." >&2
    aztec profile flamegraph "$@"
    ;;
  *)
    aztec $cmd "$@"
    ;;
esac
