---
name: ephemeral-network
description: Configure, fund, deploy, and validate an ad-hoc Aztec network on an existing GKE cluster using Spartan, with an isolated mnemonic, Terraform state, and image. Also use for redeploying or retiring that network.
---

# Ephemeral Aztec network

Use the existing Spartan environment and deployment scripts. A new network normally needs a new environment file, mnemonic, funded accounts, and a published image, not a new Helm chart or Kubernetes cluster.

## Resolve the checkout and requested operation

Work in a standalone aztec-node checkout containing the requested stack. Read its `CLAUDE.md` and `spartan/CLAUDE.md`. Paths in the references are relative to the aztec-node root unless specified otherwise.

Keep the image-building/deployment checkout isolated: the scripts write Terraform backend overrides, plans, and secret-bearing tfvars into it. Use the repository's actual PR base (`main` by default), independently of the network preset name. Record the source commit and pinned foundation/toolchain versions; do not silently substitute a different stack to obtain a buildable image.

Establish the source commit/stack, namespace, GCP project/cluster/location, L1 chain, image repository, desired lifespan/resources, and whether this is a fresh network or an existing-chain redeploy. Infer these from the request and local configuration where possible. An authorization to deploy covers the intended deployment; it does not authorize resetting an existing chain, rotating its identities, or deleting persistent data. Honor prior approvals instead of asking again.

## Workflow

1. For a new network, read [configuration and image](references/configuration.md). Verify cloud access and isolate every resource name before publishing the immutable image.
2. Read [secrets and funding](references/secrets-and-funding.md) before loading credentials or deriving accounts. Reconcile account indices with the actual Terraform capacity, then execute only the authorized funding proposal.
3. Read [deployment and operations](references/operations.md) before deployment, redeployment, monitoring, or teardown. The standard post-deploy check requires advancing blocks, accepted epoch proofs, mined transactions, no empty or missed slots, no reorgs, and no major errors in logs.

Before using real credentials, inspect the selected revision for the known secret-logging paths described in the funding reference. This is a prerequisite for safely running that revision, not a reason to print its secrets while investigating.

Maintain a secret-free deployment record at the user's requested location. Record the environment/commit, image tag and digest, context/namespace, secret **name/version only**, public funding addresses and receipts, L1 contract addresses/genesis, activation estimate, health evidence, unresolved issues, and teardown scope. When reporting a problem, append timestamp, impact, evidence, source location, and next action as it is found.
