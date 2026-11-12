# Ethereum client upgrades and disk recovery

These commands operate on the `ethereum` namespace in the public GKE cluster,
project `testnet-440309`, zone `us-west1-a`. Choose `sepolia` or `mainnet` explicitly.
Do not run Terraform, Helm upgrades, or another snapshot/restore concurrently.

## Mainnet blue/green instances

Mainnet can run more than one Reth/Lighthouse pair side by side:

- `mainnet` is the legacy pair from `modules/ethereum-node`. Its module address,
  Helm releases, PVCs, internal LoadBalancers, and Kong routes are unchanged by
  the instance mechanism below. Do not rename it.
- `mainnet-blue` and `mainnet-green` come from `modules/ethereum-node-instance`
  and are declared in `local.mainnet_instances` in `mainnet-instances.tf`.

`local.mainnet_instances` is the version-controlled record of which instances
exist, with their pinned client images, P2P ports, and source snapshots. Every
apply of this root uses it, so routine changes such as adding an API consumer
keep the instances in place. Removing an entry plans the removal of that
instance's Helm releases, PVCs, PVs, and disks; see the
[instance module lifecycle notes](../modules/ethereum-node-instance/README.md)
before doing so.

`local.mainnet_serving_slot` selects which slot backs the public mainnet Kong
execution and beacon routes and the in-cluster `mainnet-execution` (`:8545`
HTTP, `:8546` WebSocket) and `mainnet-beacon` (`:5052`) Services; `null` points
them at the legacy pair. In-cluster consumers should use those Service names
(listed in the `mainnet_serving_urls` output) so a swap needs no consumer change.
The internal API LoadBalancers and the metrics collector always target the
legacy pair.
Instance endpoints and storage identifiers are in the `mainnet_instances` output.

### Upgrade by cloning the serving pair

An upgrade clones the pair currently serving traffic onto new disks, runs the new
client versions on the clones, and moves traffic only once the clones have
recovered and synced. The source pair keeps serving throughout. Alternate between
`blue` and `green`, so the new slot is always the one not serving traffic.

1. **Snapshot the source pair while it runs** (see
   [Live snapshots](#live-snapshots)):

   ```bash
   ./snapshot-live-mainnet.sh <mainnet|mainnet-blue|mainnet-green> /path/outside/repo/<run-name>
   ```

2. **Open the new pair's P2P ports.** The `ethereum_p2p` rule in
   `spartan/terraform/gke-cluster/firewall.tf` must allow both NodePorts over TCP
   and UDP; a NodePort alone does not admit external peers. Blue uses
   32400/32401. Apply that root separately and review its full plan first.

3. **Add the slot to `local.mainnet_instances`:**

   ```hcl
   green = {
     reth_image          = "ghcr.io/paradigmxyz/reth:<tag>"
     lighthouse_image    = "sigp/lighthouse:<tag>"
     reth_p2p_port       = <nodeport>
     lighthouse_p2p_port = <nodeport + 1>
     source_snapshots = {
       reth       = "<from source-snapshots.json>"
       lighthouse = "<from source-snapshots.json>"
     }
     avoid_release_prefixes = ["mainnet-blue"]
   }
   ```

   There are no default client versions. `avoid_release_prefixes` (default
   `["mainnet"]`) keeps the new pods off the nodes running the listed pairs; list
   every pair that is still serving. Disk sizes default to 3328/512 GiB and must be
   at least the snapshots' source disk sizes. P2P ports must differ from every
   other Ethereum instance in this root, which Terraform checks, and from any other
   NodePort in the cluster, which it does not. Keep every existing slot's
   configuration unchanged.

4. **Plan and apply.** Save the plan outside the repository; it contains
   sensitive state.

   ```bash
   terraform plan -out=/path/outside/repo/mainnet-<slot>.plan
   ```

   Expect only new resources for the slot (two disks, PVs, PVCs, and Helm
   releases, and a JWT) plus the output change. Stop if the plan updates,
   replaces, or deletes anything else, including the serving pair, its storage,
   or Kong. Do not use `-target` to hide unrelated changes.

5. **Validate recovery** (see [Validating a clone](#validating-a-clone)) before
   routing any traffic to the new pair, then set `liveness_probes_enabled = true`
   for the slot. Apply that on its own, since it restarts both pods, and confirm
   they recover.

6. **Move public traffic** by setting `local.mainnet_serving_slot` to the new
   slot. The plan should only change the backend Service of the two mainnet Kong
   Ingresses and the selectors of `mainnet-execution` and `mainnet-beacon`. Node-local state does not move: clients must recreate filters and
   reconnect subscriptions. To roll back, set it to the previous slot (or `null`
   for the legacy pair) and apply again.

7. **Retire the old pair** only after traffic has moved and the new pair has run
   in production for several days. Keep its disks or snapshots until then. Never
   run older client versions against a database the newer versions have migrated.

Each restore needs capacity for a second pair alongside the serving one: infra
nodes with room for the mainnet memory requests (48 GiB Reth, 12 GiB Lighthouse)
on a node not running the source pair, and zonal disk quota for 3328 + 512 GiB.

### Live snapshots

`snapshot-live-mainnet.sh` snapshots both disks of a running pair. It only reads
Kubernetes and GCP state and creates two snapshots; it never scales, restarts,
freezes, or changes the source workloads or their disks. Snapshot names are
unique per run (`mainnet-live-<timestamp>-<random>-{reth,lighthouse}`), unlike the
fixed `*-pre-upgrade` names used by `snapshot.sh`, and `cleanup-snapshots.sh`
does not remove them.

The snapshots are crash-consistent: each matches what the client would find after
a sudden power loss, and the two are not taken atomically. Reth and Lighthouse
recover from that state on startup, and the two clients catch up with each other
over the Engine API. Snapshotting can raise the source disks' I/O latency while it
runs. A first snapshot of a disk is a full copy and takes much longer than later
incremental ones.

The required output directory must not already exist and belongs outside the
repository. It holds only metadata; the snapshot data is in GCP:

| File | Contents |
|---|---|
| `snapshot-set.json` | Target snapshot names, written before any cloud request |
| `*-pvc.json`, `*-pv.json`, `*-disk.json` | Source claim, volume, and disk |
| `*-workload.json` | Source replica count and client image |
| `*-create-operation.json`, `*-operation.json` | Submitted operation and its latest status |
| `*-snapshot.json` | Final snapshot description |
| `source-snapshots.json` | Snapshot names for `local.mainnet_instances`, written only once both are READY |

The script waits with no overall timeout and retries failed status queries. If it
is interrupted or a submission fails, GCP operations may continue: inspect the
recorded names with `gcloud compute snapshots describe` and the operation IDs with
`gcloud compute operations describe --global`. Do not delete or reuse an
incomplete set automatically; the source pair is unaffected.

### Validating a clone

A successful apply, Helm release, or Kubernetes readiness probe does not show that
a clone has recovered: readiness only checks that a port is open, and liveness
probes stay disabled so that long migrations are not restarted. Before routing
traffic, confirm from logs and the APIs that:

- both clients finish recovery and migrations, and their execution and beacon
  heads reach and track the network head;
- Lighthouse serves the same blob sidecars as the serving pair for a slot from
  before the snapshot and for one after it. The clone has a new node ID, so a
  semi-supernode custodies a different set of data columns than the stored ones.

Each clone has its own P2P identity (instance-specific Reth key and Lighthouse
network directory) and its own Engine API JWT, and Lighthouse connects only to
the same instance's Reth. When sharing traffic, route only the public execution
and beacon APIs. Do not widen the instance Services' selectors: Reth's Service
also carries the Engine API.

### Extending blue/green to Sepolia

`modules/ethereum-node-instance` already accepts `CHAIN = "sepolia"`, but this
root's wiring is mainnet-only. Making the change is a state refactor, so do it in
its own change, separate from any client upgrade:

1. **Key instances by chain.** Replace `mainnet_instances` and
   `mainnet_serving_slot` with per-chain maps (for example
   `ethereum_instances = { mainnet = { blue = {...} }, sepolia = {...} }` and
   `serving_slots = { mainnet = "blue", sepolia = null }`), flattened to
   `"<chain>-<slot>"` keys for the module's `for_each`. The `chain == "mainnet"`
   guard in `gateway_routes` then becomes a lookup of that chain's serving slot.
   Keep an unknown slot name a plan error rather than a silent fallback to the
   legacy pair.
2. **Add `moved` blocks** for every existing instance, for example from
   `module.mainnet_instances["blue"]` to `module.ethereum_instances["mainnet-blue"]`.
   Without them, Terraform plans to destroy and recreate the instance;
   `prevent_destroy` blocks that plan for the disks, PVs, and PVCs. The plan for
   the refactor must show only moves.
3. **Take per-chain values from `local.ethereum_chains`.** `mainnet-instances.tf`
   hard-codes mainnet's resources, extra arguments, checkpoint URL, disk sizes,
   and `avoid_release_prefixes = ["mainnet"]`; Sepolia's Reth disk, for example,
   is 1792 GiB.
4. **Parameterize the chain in `snapshot-live-mainnet.sh`,** which accepts only
   `mainnet*` releases and labels snapshots `eth-network=mainnet`.
5. **Allocate distinct P2P NodePorts** for each Sepolia slot and open them in the
   `gke-cluster` firewall, as for mainnet.

## Before upgrading in place (stopped-client backups)

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
