#!/usr/bin/env bash
set -euo pipefail

# Usage: L1_RPC_URL=... ROLLUP_ADDRESS=... L1_PRIVATE_KEY=... [FLUSH_CHUNK_SIZE=8] [POLL_SECONDS=60] bash flush-attesters.sh
poll_seconds=${POLL_SECONDS:-60}
# A no-arg flush activates up to maxQueueFlushSize entries, which can exceed the RPC's eth_estimateGas cap.
chunk_size=${FLUSH_CHUNK_SIZE:-8}
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
    echo "Flushing up to $chunk_size entries (allowance: $available)"
    cast send "$ROLLUP_ADDRESS" 'flushEntryQueue(uint256)' "$chunk_size" "${rpc[@]}" --private-key "$L1_PRIVATE_KEY"
  else
    echo "No flush allowance yet; waiting ${poll_seconds}s"
    sleep "$poll_seconds"
  fi
done
