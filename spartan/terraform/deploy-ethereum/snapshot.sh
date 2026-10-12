#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^(sepolia|mainnet)$ ]]; then
  echo "Usage: $0 <sepolia|mainnet>" >&2
  exit 2
fi
network=$1

project=testnet-440309
zone=us-west1-a
eth_context=gke_testnet-440309_us-west1-a_aztec-gke-public

reth_snapshot="$network-reth-pre-upgrade"
lighthouse_snapshot="$network-lighthouse-pre-upgrade"

kube=(kubectl --context="$eth_context" -n ethereum)
reth_replicas=$("${kube[@]}" get "sts/$network-reth" -o jsonpath='{.spec.replicas}')
lighthouse_replicas=$("${kube[@]}" get "sts/$network-lighthouse" -o jsonpath='{.spec.replicas}')

resolve_disk() {
  local pv handle
  pv=$("${kube[@]}" get "pvc/storage-$network-$1-0" -o jsonpath='{.spec.volumeName}')
  handle=$("${kube[@]}" get "pv/$pv" -o jsonpath='{.spec.csi.volumeHandle}')
  if [[ "$handle" != "projects/$project/zones/$zone/disks/"* ]]; then
    echo "Unexpected disk location for $network-$1: $handle" >&2
    return 1
  fi
  printf '%s\n' "${handle##*/}"
}

reth_disk=$(resolve_disk reth)
lighthouse_disk=$(resolve_disk lighthouse)
existing_snapshots=$(gcloud compute snapshots list --project="$project" \
  --filter="name=($reth_snapshot $lighthouse_snapshot)" --format='value(name)')
if [[ -n "$existing_snapshots" ]]; then
  printf 'Snapshots already exist; clean up the previous backup before rerunning:\n%s\n' "$existing_snapshots" >&2
  exit 1
fi

snapshots_started=0
snapshots_ready=0

restore_clients() {
  local result=$?
  trap - EXIT
  if (( snapshots_started && ! snapshots_ready )); then
    echo "Clients remain stopped: both backups have NOT been confirmed READY." >&2
    echo "Snapshot operations may still be running. Do not apply Terraform or restart clients yet." >&2
    echo "See $(dirname "$0")/README.md for status checks and manual recovery." >&2
    if (( result == 0 )); then
      result=1
    fi
    exit "$result"
  fi
  echo "Restoring original client replica counts."
  if ! "${kube[@]}" scale "sts/$network-reth" --replicas="$reth_replicas"; then
    echo "Failed to restore Reth; restore replicas manually." >&2
    result=1
  fi
  if ! "${kube[@]}" scale "sts/$network-lighthouse" --replicas="$lighthouse_replicas"; then
    echo "Failed to restore Lighthouse; restore replicas manually." >&2
    result=1
  fi
  exit "$result"
}

trap restore_clients EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Stopping $network clients for disk snapshots. Do not apply Terraform until this script finishes."
"${kube[@]}" scale "sts/$network-lighthouse" "sts/$network-reth" --replicas=0
"${kube[@]}" wait --for=delete "pod/$network-lighthouse-0" "pod/$network-reth-0" --timeout=10m

# A killed local gcloud process does not cancel an accepted cloud snapshot operation.
snapshots_started=1
gcloud compute snapshots create "$reth_snapshot" \
  --project="$project" \
  --source-disk="$reth_disk" \
  --source-disk-zone="$zone" &
reth_pid=$!

gcloud compute snapshots create "$lighthouse_snapshot" \
  --project="$project" \
  --source-disk="$lighthouse_disk" \
  --source-disk-zone="$zone" &
lighthouse_pid=$!

failed=0
if ! wait "$reth_pid"; then
  echo "Reth snapshot failed." >&2
  failed=1
fi
if ! wait "$lighthouse_pid"; then
  echo "Lighthouse snapshot failed." >&2
  failed=1
fi

for snapshot in "$reth_snapshot" "$lighthouse_snapshot"; do
  if ! snapshot_status=$(gcloud compute snapshots describe "$snapshot" \
    --project="$project" --format='value(status)'); then
    failed=1
    continue
  fi
  printf '%s: %s\n' "$snapshot" "$snapshot_status"
  if [[ "$snapshot_status" != READY ]]; then
    failed=1
  fi
done

if (( failed )); then
  echo "Both backups have NOT been confirmed ready." >&2
  exit 1
fi

snapshots_ready=1
echo "Both snapshots are READY."
