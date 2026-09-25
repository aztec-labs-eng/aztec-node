#!/usr/bin/env bash
set -euo pipefail

# Usage: L1_RPC_URL=... ROLLUP_ADDRESS=... L1_PRIVATE_KEY=... bash stake-attesters.sh addresses.txt
# Requires cast, aztec, node, and openssl. Input: one attester address per line.
# Sends one approval, then one deposit per address. On interruption, rerun only remaining addresses.
input=$1

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

echo "Staking ${#attesters[@]} attesters on $ROLLUP_ADDRESS (chain $chain_id)"
echo "Funder / withdrawer: $withdrawer; token: $token; total: $total base units"
cast send "$token" 'approve(address,uint256)' "$ROLLUP_ADDRESS" "$total" \
  "${rpc[@]}" --private-key "$L1_PRIVATE_KEY"

for i in "${!attesters[@]}"; do
  attester=${attesters[$i]}
  echo "[$((i + 1))/${#attesters[@]}] Staking $attester"
  # A nonzero 31-byte scalar is below the BN254 scalar field modulus.
  bls_key="0x01$(openssl rand -hex 30)"
  aztec add-l1-validator \
    --l1-rpc-urls "$L1_RPC_URL" \
    --l1-chain-id "$chain_id" \
    --rollup "$ROLLUP_ADDRESS" \
    --private-key "$L1_PRIVATE_KEY" \
    --withdrawer "$withdrawer" \
    --attester "$attester" \
    --bls-secret-key "$bls_key"
done
