# Secrets and funding

## Check secret handling first

Inspect the selected deployment revision before loading secrets. Known failure modes include:

- `spartan/scripts/setup_gcp_secrets.sh` emitting `::add-mask::<value>` outside GitHub Actions. Inspect `mask_secret_value` for an early return outside Actions; revisions without that guard print raw secrets locally.
- `spartan/aztec-node/scripts/setup-otel-resource.sh` enabling shell xtrace when sourced, then its sibling `get-private-key.sh` tracing mnemonic arguments and derived keys or explicitly echoing mnemonic words. Check the whole credential-handling path, not just one command.
- `yarn-project/aztec/src/cli/cmds/start_bot.ts` interpolating the full bot configuration into a string. Logger field redaction cannot sanitize a mnemonic already embedded in a message string.
- Deployment enrichers automatically collecting startup logs on failure. Fix the producing code or ensure the collection is sanitized before running with real credentials.

These are revision checks, not patches to reapply on every deployment. If a leak remains, use a corrected revision before supplying real secrets. GitHub masking directives provide no protection in a local terminal. Do not use `bash -x`, print full environment/configuration, dump Kubernetes Secrets, or attach raw startup logs/Terraform plans. Restrict local tfvars/state/plan permissions; they contain credentials even if console output is quiet.

For an already deployed leak, record the exposure without copying values. Treat every derived identity as exposed to log readers. Fix logging before replacing credentials. A new Secret Manager version does not safely rotate attesters, signer keystores, funded publishers, and on-chain registrations by itself; obtain authorization for the concrete rotation or fresh-network reset.

## Where the mnemonic lives

For local Spartan deployment, the mnemonic belongs in **Google Cloud Console → Secret Manager → the environment's `GCP_PROJECT_ID` → a dedicated secret → a version**. It is not a GitHub repository, environment, organization, Dependabot, or Codespaces secret.

The environment contains only references:

```bash
L1_NETWORK=sepolia
LABS_INFRA_MNEMONIC_SECRET_NAME=sepolia-labs-example-network-mnemonic
LABS_INFRA_MNEMONIC=REPLACE_WITH_GCP_SECRET
```

`setup_gcp_secrets.sh` reads the custom name when provided. Otherwise it derives `${L1_NETWORK}-labs-${NETWORK}-mnemonic`; reusing `NETWORK=next-net` without a custom name therefore reuses next-net's identity. The current loader reads `latest`, so record the resolved version and avoid changing it during a deployment.

Generate a fresh cryptographically random mnemonic using the installed wallet tooling's verified syntax, with tracing disabled. Pipe it directly to `gcloud secrets create ... --data-file=-`, or use a protected temporary file (`umask 077`, a `mktemp` directory) if a pipe is not supported. Never put the mnemonic in an inline command, chat, repository, or tool output. Check the exact command's output shape first using a disposable test; some wallet commands emit extra JSON or addresses. If creating the secret fails, do not blindly add a version to a pre-existing name: inspect metadata and confirm ownership first.

From `spartan/`, load only the non-secret environment references, then create the new secret from a protected file containing only the mnemonic. `source_env_basic` does not attempt to read the not-yet-created secret:

```bash
set +x
source ./scripts/source_env_basic.sh
source_env_basic "$network_environment"
gcloud secrets create "$LABS_INFRA_MNEMONIC_SECRET_NAME" \
  --project="$GCP_PROJECT_ID" --replication-policy=automatic \
  --data-file="$network_mnemonic_file"
```

Verify secret metadata/version creation, then remove that exact temporary file. Do not read the value back into tool output.

Grant only the actual deployment identity access. Existing shared RPC/deployer/funder secrets may already be available; read their mapping in `setup_gcp_secrets.sh` rather than inventing GitHub secrets. The deployer key is separate from the network mnemonic when `ROLLUP_DEPLOYMENT_PRIVATE_KEY` is configured. Verify all references resolve by reporting success/name/version, never value.

## Derive and audit accounts

Run `scripts/calculate_publisher_indices.sh <environment>` from Spartan, then compare its output with the **same revision's** `terraform/deploy-aztec-infra/main.tf` and key-setup scripts. Older helpers can undercount prover capacity or omit newly added workloads; do not trust a successful exit as complete coverage.

For equal primary/HA pod counts, validator publishers require:

```text
VALIDATOR_REPLICAS × VALIDATOR_PUBLISHERS_PER_REPLICA × (1 + VALIDATOR_HA_REPLICAS)
```

If HA pod counts differ, derive ranges from Terraform's actual per-release offsets. Attester count is not publisher count. Prover publisher coverage must mirror the maximum prover replica capacity used by Terraform, including `PROVER_AGENT_KEDA_MAX_REPLICAS` when KEDA is enabled and zero when proving is disabled. Check non-KEDA defaults against the actual code too. Include every enabled bot replica and its configured start index. Verify all ranges are disjoint.

Derive public addresses with the same mnemonic derivation path/index as deployment. Report index/address/balance only. Audit the separate rollup deployer and the funding source too. Attesters do not automatically need ETH merely because their keys are registered.

For workstation L1 reads, load the environment as shown below and use Foundry `cast` with an authorized execution RPC. `ETHEREUM_RPC_URLS` is a JSON array; select a reachable entry into `network_l1_rpc` without printing it. If those deployment endpoints are private `10.x` addresses, use an authorized external endpoint and export `EXTERNAL_ETHEREUM_HOST` for the funding helper instead of changing the pods' endpoints. Verify `cast chain-id --rpc-url "$network_l1_rpc"` matches `ETHEREUM_CHAIN_ID` (Sepolia is `11155111`), then audit public addresses with `cast balance --ether --rpc-url "$network_l1_rpc" "$network_account_address"`. Switch away from throttled/disabled providers; HTTP 200 alone does not prove JSON-RPC success, and batch responses must contain the expected IDs/results.

## Fund only the reviewed deficit

Prepare a read-only proposal with chain, funding source, recipient addresses/indices, current balances, low/high watermarks, exact per-recipient deficit, deployer top-up, total value, and gas headroom. Choose amounts for the run's duration/load rather than copying another network's budget. If the user will supply funds, give the public funding address, chain, and total, then wait for a confirmed receipt/balance. Never request their private key in chat.

`scripts/ensure_funded_environment.sh` and `scripts/ensure_eth_balances.sh` **send transactions**; neither is a dry-run balance checker. Inspect their current behavior and use them only after the funding amounts/destination are authorized. A funding proposal not already covered by the user's approval needs explicit approval before broadcast.

From `spartan/`, load the environment in a no-xtrace shell after the secret-handling check. `source_network_env` sources the environment, calls `gcp_auth` before Secret Manager reads, and exports the resolved values:

```bash
set +x
source ./scripts/source_network_env.sh
source_network_env "$network_environment"
```

After completing the read-only audit, setting a reachable RPC, and obtaining the funding approval, run:

```bash
./bootstrap.sh ensure_funded_environment "$network_environment" "$network_low_watermark" "$network_high_watermark"
```

The bootstrap target currently expands `FUNDING_PRIVATE_KEY` before calling its helper; it does not load that key itself. Keep the explicit loading step in the same shell. The helper sources the environment again, so account for that when setting overrides. It checks publisher/bot balances and separately the deployer; its lower-level helper can fund many recipients with Multicall3. If the current index helper is incomplete, correct/test it before funding. Verify receipts, transferred amounts, and resulting balances; record public transaction hashes. On an ambiguous send failure, inspect nonce/receipt before retrying to avoid duplicate transfers.
