#!/usr/bin/env bash
set -euo pipefail

# Usage: L1_RPC_URL=... ROLLUP_ADDRESS=... L1_PRIVATE_KEY=... MOVE_WITH_LATEST_ROLLUP=false bash stake-attesters.sh addresses.txt
# Set AZTEC_CLI to an executable path to override the locally built CLI.
# Requires cast, node, openssl, and a built local Aztec CLI. Input: one attester address per line.
# Sends one approval, then one deposit per address. On interruption, rerun only remaining addresses.
input=$1
repo_root=$(realpath "$(dirname "${BASH_SOURCE[0]}")/../..")
aztec_cmd=(node --no-warnings "$repo_root/yarn-project/aztec/dest/bin/index.js")
if [[ -n "${AZTEC_CLI:-}" ]]; then
  aztec_cmd=("$AZTEC_CLI")
fi
move_with_latest_rollup=${MOVE_WITH_LATEST_ROLLUP:-true}
case "$move_with_latest_rollup" in
  true) rollup_option=() ;;
  false) rollup_option=(--no-move-with-latest-rollup) ;;
  *) echo "MOVE_WITH_LATEST_ROLLUP must be true or false" >&2; exit 1 ;;
esac

if [[ "$move_with_latest_rollup" == false ]]; then
  cli_help=$("${aztec_cmd[@]}" add-l1-validator --help)
  if [[ "$cli_help" != *--no-move-with-latest-rollup* ]]; then
    echo "Selected Aztec CLI does not support --no-move-with-latest-rollup" >&2
    exit 1
  fi
fi

attesters=()
while read -r attester || [[ -n "$attester" ]]; do
  attester=${attester%$'\r'}
  [[ -z "$attester" ]] && continue
  attesters+=("$attester")
done < "$input"

rpc=(--rpc-url "$L1_RPC_URL")
withdrawer=$(cast wallet address --private-key "$L1_PRIVATE_KEY")
chain_id=$(cast chain-id "${rpc[@]}")
token=$(cast call "$ROLLUP_ADDRESS" 'getStakingAsset()(address)' "${rpc[@]}")
stake=$(cast call "$ROLLUP_ADDRESS" 'getActivationThreshold()(uint256)' "${rpc[@]}" | awk '{print $1}')
total=$(node -e 'console.log((BigInt(process.argv[1]) * BigInt(process.argv[2])).toString())' "$stake" "${#attesters[@]}")

echo "Staking ${#attesters[@]} attesters on $ROLLUP_ADDRESS (chain $chain_id; moveWithLatestRollup=$move_with_latest_rollup)"
echo "Funder / withdrawer: $withdrawer; token: $token; total: $total base units"
cast send "$token" 'approve(address,uint256)' "$ROLLUP_ADDRESS" "$total" \
  "${rpc[@]}" --private-key "$L1_PRIVATE_KEY"

for i in "${!attesters[@]}"; do
  attester=${attesters[$i]}
  echo "[$((i + 1))/${#attesters[@]}] Staking $attester"
  # A nonzero 31-byte scalar is below the BN254 scalar field modulus.
  bls_key="0x01$(openssl rand -hex 30)"
  "${aztec_cmd[@]}" add-l1-validator \
    --l1-rpc-urls "$L1_RPC_URL" \
    --l1-chain-id "$chain_id" \
    --rollup "$ROLLUP_ADDRESS" \
    --private-key "$L1_PRIVATE_KEY" \
    --withdrawer "$withdrawer" \
    --attester "$attester" \
    "${rollup_option[@]}" \
    --bls-secret-key "$bls_key"
done
