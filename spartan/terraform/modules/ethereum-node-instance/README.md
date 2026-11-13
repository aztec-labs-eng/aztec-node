# Named Ethereum node instances

Deploys an independently named Reth/Lighthouse pair, optionally initialized from
two GCP snapshots. The legacy `../ethereum-node` module is intentionally unchanged;
use this module for new mainnet blue/green instances.

Each instance owns:

- Two zonal `pd-balanced` disks, restored from `SOURCE_SNAPSHOTS` or created empty
  when that input is null.
- Two ext4 CSI PVs, pre-bound to instance-specific PVCs. Both PVs use `Retain`;
  the claims cannot dynamically provision empty replacement disks.
- Two Helm releases with ClusterIP API Services and distinct P2P NodePorts.
- A shared, instance-local Engine API JWT. Lighthouse connects only to the
  instance's Reth Service.

The module creates no Kong routes, DNS records, or API LoadBalancer Services.

## Initialization and recovery

`SOURCE_SNAPSHOTS` accepts snapshot **names** in `PROJECT`, not URLs. Verify both
snapshots are READY, belong to the intended mainnet clients, and have disk sizes
no greater than the requested `CLIENTS.*.storage_gib` before applying. GCP also
rejects disks smaller than their source snapshots.

Disk creation allows up to two hours. A local timeout does not prove the cloud
operation has stopped; inspect the disk and Compute operation before retrying or
attempting to replace a partially managed disk.

Snapshots are creation-time inputs. Keep their names in configuration after the
initial restore, even if the snapshots are later deleted. There is deliberately
no snapshot data source requiring backups to remain present for future plans.
Changing a source snapshot would require replacing the disk, which
`prevent_destroy` blocks while the resource remains configured. To retry recovery,
use another instance with new storage; do not reset an existing instance's disks.

Cloned databases also contain P2P identity files. The new releases use
instance-specific Reth key and Lighthouse network-directory paths instead of
deleting or using the source node's keys. The chart-mounted JWT replaces the
snapshot's JWT at runtime. Instance prefixes must be unique among concurrently
running pairs.

Chart liveness probes are disabled by default because recovery or migrations can
run before API/P2P ports open. Readiness probes are still enabled but do **not**
establish sync or execution-validation health. Manually validate recovery and
sustained syncing, then enable `LIVENESS_PROBES_ENABLED` before production use.

`AVOID_RELEASE_PREFIXES` requires these pods to run off nodes hosting the listed
Reth/Lighthouse instances. This can require cluster autoscaling. Both disks and
pods are pinned to `ZONE`; check regional disk quota and zonal node capacity.

## Disk growth

For a new instance, `CLIENTS.*.storage_gib` sets the initial disk size, PV capacity,
and PVC request. After creation, Terraform ignores disk `size` and PV `capacity`
changes so that only PVC requests drive expansion. The CSI driver grows the disk,
updates the PV, and expands ext4; directly updating PV capacity can bypass that
process.

To grow an existing mainnet instance, increase its `reth_storage_gib` or
`lighthouse_storage_gib` in the deployment registry. Review a plan that changes
only the corresponding PVC storage request in place, with no disk/PV resizing
or replacements. The StorageClass must allow volume expansion, as `standard-rwo`
does. GKE supports online ext4 expansion, so a pod restart is normally unnecessary.
After applying, verify both the PVC's reported capacity and `df -h /data` in the
client container. Disk/PV size drift is ignored by Terraform, so a no-change plan
alone does not verify usable filesystem capacity.

Shrinking existing volumes is unsupported; do not decrease their requested sizes.
No new snapshot or restore is needed for growth.

## Lifecycle

Review the full root plan, not just a targeted plan. Creating a candidate must
not change the legacy instances, existing storage, or gateway configuration.

Disk, PV, and PVC resources have `prevent_destroy`. PV `Retain` prevents Kubernetes
from deleting disks when claims are removed; it does not prevent Terraform from
deleting its explicitly managed disks. Removing the module configuration also
removes Terraform's lifecycle safeguards. Teardown requires a separately reviewed
plan and an explicit decision about which disks and snapshots to keep.
