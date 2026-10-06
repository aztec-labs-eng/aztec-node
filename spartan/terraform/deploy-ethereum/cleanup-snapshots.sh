#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^(sepolia|mainnet)$ ]]; then
  echo "Usage: $0 <sepolia|mainnet>" >&2
  exit 2
fi
network=$1

printf 'Delete %s-reth-pre-upgrade and %s-lighthouse-pre-upgrade in project testnet-440309?\n' "$network" "$network" >&2
printf 'This removes both rollback backups. Type "%s" to confirm: ' "$network" >&2
if ! read -r confirmation || [[ "$confirmation" != "$network" ]]; then
  echo "Deletion cancelled." >&2
  exit 1
fi

gcloud compute snapshots delete \
  "$network-reth-pre-upgrade" \
  "$network-lighthouse-pre-upgrade" \
  --project=testnet-440309 \
  --quiet

echo "Deleted both $network pre-upgrade snapshots."
