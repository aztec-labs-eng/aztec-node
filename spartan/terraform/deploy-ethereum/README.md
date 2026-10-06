# Ethereum client upgrades and disk recovery

These commands operate on the `ethereum` namespace in the public GKE cluster,
project `testnet-440309`, zone `us-west1-a`. Choose `sepolia` or `mainnet` explicitly.
Do not run Terraform, Helm upgrades, or another snapshot/restore concurrently.

## Before upgrading

Record both clients' replica counts, image versions, and PVC/PV manifests in an
incident directory before running `./snapshot.sh <network>`. The named backups are
`<network>-reth-pre-upgrade` and `<network>-lighthouse-pre-upgrade`. Only upgrade
when the script exits successfully and reports both snapshots READY. Successful
runs restore the original replica counts. Existing backups are never overwritten.

The script leaves clients stopped if snapshot creation has started and both
backups cannot be confirmed READY, including on SIGINT/SIGTERM. Killing a local
`gcloud` process does not cancel a snapshot operation already accepted by GCP.
If the entire process group is killed (or the machine is lost), assume operations
may still be running; do not restart clients just because the local command ended.

## After a failed or interrupted snapshot

```bash
network=sepolia  # or mainnet
project=testnet-440309
zone=us-west1-a
context=gke_testnet-440309_us-west1-a_aztec-gke-public
kube=(kubectl --context="$context" -n ethereum)

for client in reth lighthouse; do
  gcloud compute snapshots describe "$network-$client-pre-upgrade" \
    --project="$project" --format='yaml(name,status,sourceDisk)'
done
```

Wait until both snapshots are READY before restoring the recorded replica counts.
If a snapshot is missing, FAILED, or cannot be queried, keep the clients stopped
and inspect the relevant GCP Compute operations. A failed local command or a
missing snapshot is not proof that the cloud operation has finished. Confirm all
operations have completed or been cancelled in GCP before restarting without a
usable backup. Such a restart does **not** authorize proceeding with the upgrade:
clean up the failed backup attempt and rerun the snapshot first.

Restore each recorded count manually, for example (substitute the actual counts):

```bash
"${kube[@]}" scale "sts/$network-reth" --replicas=1
"${kube[@]}" scale "sts/$network-lighthouse" --replicas=1
```

## Roll back using the snapshots

Restore both disks as a pair. Do not run an older client against a database modified
by the newer version. Keep the original disks and snapshots until recovery has
been verified. This procedure changes live Kubernetes resources; do not run
Terraform during it.

1. Record current replica counts and set both StatefulSets to zero. Wait for both
   pods to be deleted, then confirm their disks are detached (check the disk's
   `users` field with `gcloud compute disks describe`). Restore the recorded
   pre-upgrade Reth and Lighthouse image versions in `main.tf` and the stopped
   StatefulSets. Do not use `terraform apply` to roll back images while swapping
   disks: it can restart the clients.
2. Confirm both snapshots are READY and their `sourceDisk` fields match the disks
   belonging to the selected network. For each client, export its current claim
   and volume manifests and set the original PV reclaim policy to Retain:

   ```bash
   client=reth  # repeat for lighthouse
   pvc="storage-$network-$client-0"
   pv=$("${kube[@]}" get "pvc/$pvc" -o jsonpath='{.spec.volumeName}')
   "${kube[@]}" get "pvc/$pvc" -o json > "$client-pvc.json"
   "${kube[@]}" get "pv/$pv" -o json > "$client-pv.json"
   "${kube[@]}" patch "pv/$pv" --type=merge \
     -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
   ```

3. Create a **new** disk from each snapshot, in the original zone. Choose unique
   names; never delete or overwrite the original disk. Confirm the restored disk
   is at least as large as the saved PV capacity (increase `--size` if necessary).

   ```bash
   disk="$network-$client-restored-$(date +%s)"
   gcloud compute disks create "$disk" --project="$project" --zone="$zone" \
     --source-snapshot="$network-$client-pre-upgrade" --type=pd-balanced
   ```

4. Create a static CSI PV pointing to the new disk, preserving the original
   capacity, access modes, filesystem, storage class, and node affinity. Its
   `volumeHandle` is immutable, so create a new PV rather than patching the old one.
   Pre-bind a replacement PVC under the original claim name to avoid dynamic
   provisioning of an empty disk:

   ```bash
   restored_pv="$pv-restored-$(date +%s)"
   handle="projects/$project/zones/$zone/disks/$disk"
   jq --arg name "$restored_pv" --arg handle "$handle" '
     del(.status, .metadata.uid, .metadata.resourceVersion,
         .metadata.creationTimestamp, .metadata.managedFields,
         .metadata.annotations, .metadata.finalizers, .metadata.ownerReferences,
         .spec.claimRef)
     | .metadata.name = $name
     | .spec.csi.volumeHandle = $handle
     | .spec.persistentVolumeReclaimPolicy = "Retain"
   ' "$client-pv.json" > "$client-restored-pv.json"
   jq --arg pv "$restored_pv" '
     del(.status, .metadata.uid, .metadata.resourceVersion,
         .metadata.creationTimestamp, .metadata.managedFields,
         .metadata.annotations, .metadata.finalizers, .metadata.ownerReferences)
     | .spec.volumeName = $pv
   ' "$client-pvc.json" > "$client-restored-pvc.json"
   "${kube[@]}" create -f "$client-restored-pv.json"
   "${kube[@]}" delete "pvc/$pvc" --wait=true
   "${kube[@]}" create -f "$client-restored-pvc.json"
   ```

   Repeat steps 2–4 for Lighthouse. Verify both replacement PVCs are Bound to the
   intended new PVs, and both CSI handles point to the restored disks before
   starting either client. The old PVs remain Released and retain the old disks.
5. Restore the recorded replica counts. Check pod logs, execution/beacon health,
   chain ID, and advancing execution and beacon heads. Review a Terraform plan
   against the rolled-back image configuration before resuming normal management.
   Do not destroy the retained original disks/PVs as part of this recovery.

## Delete backups after verification

Run `./cleanup-snapshots.sh <network>` only after verifying the upgrade or recovery
and deciding rollback copies are no longer needed. The script displays the project
and snapshot names and requires typing the selected network before deleting them.
It does not delete retained disks or PVs.

## Local regression tests

```bash
python3 spartan/terraform/deploy-ethereum/snapshot_test.py
```

The tests use fake `kubectl` and `gcloud` executables; they do not access GCP or a
Kubernetes cluster. The recovery procedure still requires validation by an operator
in the target environment.
