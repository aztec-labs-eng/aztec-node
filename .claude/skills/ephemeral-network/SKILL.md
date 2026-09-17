---
name: ephemeral-network
description: Configure, fund, deploy, and validate an ad-hoc Aztec network on an existing GKE cluster using Spartan, with an isolated mnemonic, Terraform state, and image. Also use for redeploying or retiring that network.
---

# Ephemeral Aztec network

Use the existing Spartan environment and deployment scripts. A new network normally needs a new environment file, mnemonic, funded accounts, and a published image, not a new Helm chart or Kubernetes cluster.

Usage: name the environment and operation (create, redeploy, check, or retire), plus the source revision for a new deployment.

## Resolve the checkout and requested operation

Work in a standalone aztec-node checkout containing the requested stack. Read its `CLAUDE.md` and `spartan/CLAUDE.md`. Paths in the references are relative to the aztec-node root unless specified otherwise.

Keep the image-building/deployment checkout isolated: the scripts write Terraform backend overrides, plans, and secret-bearing tfvars into it. Record the source commit and pinned foundation/toolchain versions.

Resolve the source revision, namespace, GCP project/cluster/location, L1 chain, image repository, lifespan/resources, and whether this is a fresh network or an existing-chain redeploy from the request and configuration.

## Workflow

For a new deployment, follow this order. Shell variables below hold the chosen environment basename, image, and namespace; keep them in the same shell or set them again when resuming.

1. Read [configuration and image](references/configuration.md), verify access/context, and create `spartan/environments/<environment>.env` with isolated names.
2. From the repository root, validate with `(cd spartan && ./bootstrap.sh build)`. Commit the configuration, then run `make release-image` to build its dependencies and invoke the release-image wrapper.
3. Retag/push the immutable image using the configuration reference and record its digest as `network_image`.
4. Read [secrets and funding](references/secrets-and-funding.md), check that the selected revision handles secrets safely, and create the dedicated GCP mnemonic secret using its documented command.
5. Enter `spartan/`. Run `./scripts/calculate_publisher_indices.sh "$network_environment"`, reconcile the indices with Terraform, and complete the public-address/balance audit.
6. After approval of the funding proposal, use the funding reference's explicit environment-loading sequence followed by `./bootstrap.sh ensure_funded_environment "$network_environment" "$network_low_watermark" "$network_high_watermark"`. Verify receipts and balances.
7. Read [deployment and operations](references/operations.md), then run `CREATE_ROLLUP_CONTRACTS=true AZTEC_DOCKER_IMAGE="$network_image" ./bootstrap.sh network_deploy "$network_environment"` for the authorized fresh deployment.
8. Run `./bootstrap.sh wait_for_l2_block "$network_environment"`, reselect `kubens "$network_namespace"`, and complete the operations reference's six health gates: advancing blocks, accepted epoch proofs, mined transactions, no empty/missed slots, no reorgs, and no major log errors.

For redeployment, monitoring, or retirement, go directly to the corresponding operations guidance; do not repeat new-secret, funding, or contract-creation steps automatically.

Maintain a secret-free deployment record at the user's requested location. Record the environment/commit, image tag and digest, context/namespace, secret **name/version only**, public funding addresses and receipts, L1 contract addresses/genesis, activation estimate, health evidence, unresolved issues, and teardown scope. When reporting a problem, append timestamp, impact, evidence, source location, and next action as it is found.
