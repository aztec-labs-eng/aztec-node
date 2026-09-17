# Deployment and operations

## First deployment and redeployment

From the selected checkout's `spartan/`, after configuration/image/funding checks:

```bash
CREATE_ROLLUP_CONTRACTS=true \
  AZTEC_DOCKER_IMAGE="$network_image" \
  ./bootstrap.sh network_deploy "$network_environment"
```

This command applies Terraform and deploys L1 contracts and Kubernetes workloads; it is not a plan-only preview. `deploy_network.sh` writes backend overrides and tfvars for each module and may auto-approve destroy/apply steps. Ensure the requested scope is approved before running it.

Use `CREATE_ROLLUP_CONTRACTS=true` only for the authorized first deployment or deliberate reset. The script destroys the prior contract-deployment Terraform resources before replacing them; already deployed L1 contracts cannot be erased. For normal image updates use explicit `CREATE_ROLLUP_CONTRACTS=false` and `DESTROY_NAMESPACE=false`, preserving the namespace, state and PVCs. Beware: if no registry output exists, the wrapper can still deploy contracts with the flag false. Check the exact backend and existing public registry output before treating an invocation as an existing-chain redeploy.

The wrapper may suppress routine logs while work continues. Track the process and namespace, pending pods, events, rollout status, and specific completed jobs rather than launching a second deployment. A lost terminal/process result is not evidence nothing deployed; inspect state/resources before retrying. Do not clear state locks unless the associated operation is confirmed dead and the exact lock is in scope.

Record the public L1 contract addresses, chain ID, genesis, image digest, and deployment result. Confirm those addresses agree across RPC nodes and the expected L1 code/configuration. Use `aztec_getL1ContractAddresses` or specific public Terraform outputs, not a full state/secret dump.

## Activation and health gates

Expected first committee timing is approximately:

```text
(max(validator-set lag, RANDAO lag) + 1) × slots per epoch × seconds per slot
```

Calculate the activation window from the actual on-chain configuration and inspect `scripts/wait_for_l2_block.sh`; its timeout includes a buffer. Pre-activation `NoCommitteeError` is expected only within that window. Use:

```bash
./bootstrap.sh wait_for_l2_block "$network_environment"
kubens "$network_namespace"
```

Credential refresh in the waiter can reset the namespace, hence the final `kubens` check. Verify `kubectl config current-context`, `kubectx -c`, and `kubens -c` again. Use explicit namespace/context for subsequent diagnostics.

First confirm validators, RPC, bootstrap, signer/HA database, prover node and broker are Ready, synchronized, and peered, with stable restart counts. Then run the standard post-deploy health check over an explicit UTC window after activation:

- **Blocks are being produced:** sample RPC height at least twice, verify advancement, and inspect recent canonical block timestamps for stalls.
- **Epochs are getting proven:** follow a closed epoch through proof submission and acceptance on L1. A checkpoint subproof or completed proving job is not an accepted epoch proof. Compare proven and pending progress against the configured submission deadline; inspect KEDA scaling and queued work if proving falls behind.
- **Transactions are getting mined:** follow transaction hashes from the configured bots or other authorized traffic to successful canonical L2 receipts. Report mined, failed, and still-pending counts. Healthy pods alone do not demonstrate inclusion; if no traffic exists, state that this check remains unverified.
- **No empty or missed slots:** derive expected completed slots from genesis and the on-chain timing configuration, then compare with canonical slot/checkpoint data. Exclude pre-activation and the current incomplete slot. Report every slot without its expected checkpoint and the numerator/denominator; block-height differences are insufficient because multiple blocks can share a slot. Also report produced checkpoints with zero transactions separately, so a traffic gap is not confused with a missing proposal.
- **No reorgs:** reconcile reorg/prune events across archiver, sequencer, canonical L1 receipts, and affected L2 receipts. Distinguish actual events from handler registration or configuration messages. Report any event and its impact rather than treating later progress as proof that no reorg occurred.
- **No major errors in logs:** sweep every deployed component, including bots and proving agents, for errors and warnings. Investigate slashing/offenses, attestation timeouts, unexplained conflicts/prunes, recurring failures, and crash loops. Record counts, impact, and recovery evidence for each material issue.

Observe long enough for at least one active epoch to close and its proof to be accepted before declaring the full check complete. Report each gate as passed, failed, or still pending with evidence; a deployment command succeeding does not establish network health. The `network-spot-check` and `network-logs` skills in the deployment checkout provide the detailed log workflow when available. Do not invoke mutation-heavy scenario suites (slashing, chaos, reorg, upgrades) merely to health-check a running network.

Known startup issues to investigate rather than normalize:

- Bot init and startup-probe deadlines can expire before protocol activation. Restart loops can repeat setup and collide with pending transactions. Compare the selected chart's deadlines to the computed activation window and inspect whether health means setup completed.
- Prover libp2p `ERR_NO_VALID_ADDRESSES` can recover during address/CNI readiness; confirm peers and stable restarts, and diagnose persistence rather than repeatedly deleting the pod.
- HA database migrations can race database readiness; verify completion after `pg_isready` rather than inferring failure from one `ECONNREFUSED`.

## Safe log review

Use structured Cloud Logging records with `resource.type="k8s_container"`, explicit project/cluster/namespace, and bounded UTC start/end timestamps. Select known message families and allowlisted fields. Do not dump whole `textPayload`, config messages, or arbitrary `jsonPayload`: even a structured message string can contain an interpolated mnemonic. Filter in the query before displaying results. Count results and paginate/split windows if limits are reached; a capped query is not a complete sweep.

Append new findings and evidence to the deployment record. Report separately what is healthy, what recovered, what remains broken, and which checks were blocked by credentials or unavailable history.

## Retirement

Only tear down when requested or covered by an explicit previously agreed expiry. Present the exact context, namespace, Terraform prefixes, PVC/PV effects, and object-store prefixes before any destructive step; do not treat a deployment approval as a deletion approval.

Inspect `scripts/network_teardown.sh` in the selected revision. It deletes namespace-scoped Chaos resources (including finalizer handling) and the namespace. It does **not** clean GCS Terraform state, cloud object stores, Docker tags, mnemonic secrets, or L1 contracts. Verify PVC reclaim policies before deletion. Run it only with the validated namespace and selected context after authorization; do not use `DESTROY_NAMESPACE=true` in a deploy command as a convenient standalone teardown, because that command proceeds to redeploy.

Decide separately which Terraform records, snapshots/blobs, failed-proof artifacts, registry images, and secret versions must be retained or removed. Keep state until its managed resources are accounted for; never recursively delete a shared bucket/prefix. L1 contracts remain deployed and leftover Sepolia funds remain on their addresses; refunds require their own authorized transaction amounts/destinations. Verify namespace/workload removal and report residual resources plus the recovery implications of deleted PVCs.
