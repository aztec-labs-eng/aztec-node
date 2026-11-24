#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || ! "$1" =~ ^mainnet(-(blue|green))?$ || -z "$2" ]]; then
  echo "Usage: $0 <mainnet|mainnet-blue|mainnet-green> <new-output-directory>" >&2
  exit 2
fi
source_release=$1

project=testnet-440309
zone=us-west1-a
context=gke_testnet-440309_us-west1-a_aztec-gke-public
snapshot_set="mainnet-live-$(date -u +%Y%m%d-%H%M%S)-$RANDOM"
output_dir=$2
kube=(kubectl --context="$context" -n ethereum)

for dependency in kubectl gcloud jq; do
  command -v "$dependency" >/dev/null || { echo "Missing dependency: $dependency" >&2; exit 1; }
done

mkdir -p -- "$(dirname -- "$output_dir")"
mkdir -p -- "$output_dir"

report_failure() {
  local result=$?
  if (( result != 0 )); then
    echo "Snapshot set incomplete. Inspect $output_dir and GCP snapshot operations before retrying." >&2
    echo "Accepted cloud operations may still be running. Source workloads have not been modified." >&2
  fi
}
trap report_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

jq -n --arg project "$project" --arg zone "$zone" --arg context "$context" \
  --arg source "$source_release" --arg set "$snapshot_set" \
  '{project: $project, zone: $zone, context: $context, source_release: $source,
    snapshot_set: $set, consistency: "crash-consistent",
    source_snapshots: {reth: ($set + "-reth"), lighthouse: ($set + "-lighthouse")}}' \
  > "$output_dir/snapshot-set.json"

declare -A disks handles operations
for client in reth lighthouse; do
  pvc="storage-$source_release-$client-0"
  "${kube[@]}" get "pvc/$pvc" -o json > "$output_dir/$client-pvc.json"
  pv=$(jq -er 'select(.status.phase == "Bound") | .spec.volumeName // empty' "$output_dir/$client-pvc.json")
  "${kube[@]}" get "pv/$pv" -o json > "$output_dir/$client-pv.json"
  handle=$(jq -er 'select(.spec.csi.driver == "pd.csi.storage.gke.io" and .spec.csi.fsType == "ext4")
    | .spec.csi.volumeHandle // empty' "$output_dir/$client-pv.json")
  if [[ ! "$handle" =~ ^projects/$project/zones/$zone/disks/[a-z][-a-z0-9]*$ ]]; then
    echo "Unexpected disk location for $pvc: $handle" >&2
    exit 1
  fi
  handles[$client]=$handle
  disks[$client]=${handle##*/}
  gcloud compute disks describe "${disks[$client]}" --project="$project" --zone="$zone" \
    --format=json > "$output_dir/$client-disk.json"
  "${kube[@]}" get "sts/$source_release-$client" -o json | jq -e --arg client "$client" \
    '{replicas: .spec.replicas, image: (.spec.template.spec.containers[] | select(.name == $client) | .image)}' \
    > "$output_dir/$client-workload.json"
done

existing=$(gcloud compute snapshots list --project="$project" \
  --filter="name=($snapshot_set-reth $snapshot_set-lighthouse)" --format='value(name)')
if [[ -n "$existing" ]]; then
  printf 'Refusing to reuse existing snapshot names:\n%s\n' "$existing" >&2
  exit 1
fi

printf 'Creating live snapshots in %s from %s. Clients will remain running.\n' "$project" "$source_release"
printf 'Snapshot set: %s\nMetadata: %s\n' "$snapshot_set" "$output_dir"
failed=0
for client in reth lighthouse; do
  if ! gcloud compute snapshots create "$snapshot_set-$client" \
    --project="$project" \
    --source-disk="${disks[$client]}" \
    --source-disk-zone="$zone" \
    --description="Live crash-consistent snapshot of $source_release-$client; set $snapshot_set" \
    --labels="eth-network=mainnet,eth-client=$client,source-release=$source_release,snapshot-set=$snapshot_set" \
    --async --format=json > "$output_dir/$client-create-operation.json"; then
    echo "$client snapshot submission failed; check GCP before retrying." >&2
    failed=1
    continue
  fi
  if ! operation=$(jq -er '.name // empty' "$output_dir/$client-create-operation.json"); then
    echo "$client snapshot submission did not return an operation ID." >&2
    failed=1
    continue
  fi
  operations[$client]=$operation
  printf '%s: submitted %s\n' "$snapshot_set-$client" "$operation"
done

for client in reth lighthouse; do
  if [[ -z "${operations[$client]:-}" ]]; then
    continue
  fi
  while :; do
    if ! gcloud compute operations describe "${operations[$client]}" --global --project="$project" \
      --format=json > "$output_dir/$client-operation.json.tmp"; then
      echo "$client operation status query failed; retrying in 10 seconds." >&2
      sleep 10
      continue
    fi
    mv -- "$output_dir/$client-operation.json.tmp" "$output_dir/$client-operation.json"
    status=$(jq -er '.status' "$output_dir/$client-operation.json")
    printf '%s: operation %s\n' "$snapshot_set-$client" "$status"
    case "$status" in
      PENDING|RUNNING) sleep 10 ;;
      DONE)
        if jq -e '.error != null' "$output_dir/$client-operation.json" >/dev/null; then
          echo "$client snapshot operation failed:" >&2
          jq '.error' "$output_dir/$client-operation.json" >&2
          failed=1
        fi
        break
        ;;
      *)
        echo "Unexpected operation status: $status" >&2
        failed=1
        break
        ;;
    esac
  done
done

if (( failed )); then
  exit 1
fi

for client in reth lighthouse; do
  while :; do
    if ! gcloud compute snapshots describe "$snapshot_set-$client" --project="$project" \
      --format=json > "$output_dir/$client-snapshot.json.tmp"; then
      echo "$client snapshot status query failed; retrying in 10 seconds." >&2
      sleep 10
      continue
    fi
    mv -- "$output_dir/$client-snapshot.json.tmp" "$output_dir/$client-snapshot.json"
    if ! jq -e --arg source "${handles[$client]}" \
      '(.sourceDisk // "") | endswith($source)' "$output_dir/$client-snapshot.json" >/dev/null; then
      echo "$client snapshot does not match its source disk." >&2
      failed=1
      break
    fi
    status=$(jq -er '.status' "$output_dir/$client-snapshot.json")
    printf '%s: %s\n' "$snapshot_set-$client" "$status"
    case "$status" in
      READY) break ;;
      CREATING|UPLOADING) sleep 10 ;;
      *)
        echo "Unexpected snapshot status: $status" >&2
        failed=1
        break
        ;;
    esac
  done
done

if (( failed )); then
  exit 1
fi

jq '.source_snapshots' "$output_dir/snapshot-set.json" > "$output_dir/source-snapshots.json"
echo "Both snapshots are READY. Copy these names into the reviewed instance configuration:"
jq . "$output_dir/source-snapshots.json"
echo "Source workloads are unchanged. Snapshot restore and database recovery have not been tested."
