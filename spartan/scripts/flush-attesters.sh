#!/usr/bin/env bash
set -euo pipefail

# Usage: L1_RPC_URL=... ROLLUP_ADDRESS=... L1_PRIVATE_KEY=... bash flush-attesters.sh
poll_seconds=${POLL_SECONDS:-60}
rpc=(--rpc-url "$L1_RPC_URL")

while true; do
  queued=$(cast call "$ROLLUP_ADDRESS" 'getEntryQueueLength()(uint256)' "${rpc[@]}" | awk '{print $1}')
  bootstrapped=$(cast call "$ROLLUP_ADDRESS" 'getIsBootstrapped()(bool)' "${rpc[@]}")
  echo "$(date -u +%FT%TZ) Queued: $queued; bootstrapped: $bootstrapped"
  if [[ "$queued" == 0 ]]; then
    echo "Queue empty. Done."
    break
  fi

  available=$(cast call "$ROLLUP_ADDRESS" 'getAvailableValidatorFlushes()(uint256)' "${rpc[@]}" | awk '{print $1}')
  if [[ "$available" != 0 ]]; then
    echo "Flushing queue (allowance: $available)"
    cast send "$ROLLUP_ADDRESS" 'flushEntryQueue()' "${rpc[@]}" --private-key "$L1_PRIVATE_KEY"
  else
    echo "No flush allowance yet; waiting ${poll_seconds}s"
  fi
  sleep "$poll_seconds"
done
