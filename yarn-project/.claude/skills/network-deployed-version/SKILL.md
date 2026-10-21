---
name: network-deployed-version
description: Determine which git commit an Aztec network (next-net, staging, testnet, mainnet) is running now or was running at a past time T, and whether a specific fix or PR is live on it. Use for incident triage ("was the fix deployed when X happened?"), confirming a fix reached a network, or identifying the exact deployed commit.
---

# Determine an Aztec network's deployed commit

Aztec networks deploy via GitHub Actions workflows in `aztec-labs-eng/aztec-node`: next-net on a nightly schedule, every other network by a manual dispatch of Deploy Network. Each deploy run deploys a released **docker image tag**, so the commit a network runs at time T is the **commit of the image tag deployed by the last *successful* deploy run for that network at or before T**. A failed Deploy Network run leaves the previous deployment in place, so the live commit can be older than the latest run; a failed Deploy Next Net run tears next-net down instead (its `teardown-stale-network` job).

> Do not infer deployed code from local `origin/main` — a network runs the last successful deploy, not the branch tip.

## Run the investigation in a subagent

Do **not** run the `gh`/`gcloud` commands below in the main conversation — they flood context with run lists and raw file dumps for what is ultimately a one-line answer. Instead, **spawn a `general-purpose` subagent**, hand it the query parameters, and point it at this file. Relay only its condensed answer to the user.

Subagent prompt template (fill in the bracketed parts):

> Determine [which commit `next-net` was running at 2026-06-20 14:00 UTC / whether the fix from public PR #23940 is live on `testnet` now / which commit `staging-public` is running now]. The working directory is `yarn-project`. Read the file `.claude/skills/network-deployed-version/SKILL.md` and follow its "Procedure" steps exactly, using the "Network → deploy workflow" table to pick the right workflow id.
>
> Return **only**: the deployed commit (full SHA + short), the deploy run id and the time it finished, whether the target fix/PR is present and the evidence you used to decide, and any relevant caveat. Do not paste raw `gh run list` output or file contents.

If the optional live cross-check (step 5) is needed, the subagent can itself delegate to the `network-logs` agent.

## Network → deploy workflow

| Network | Workflow | id | Image deployed | Cadence |
|---|---|---|---|---|
| next-net | Deploy Next Net | 333053202 | the day's nightly, `<manifest version>-nightly.<YYYYMMDD>`, or the `image_tag` of a manual dispatch; it calls Deploy Network as a job of the same run | nightly, cron `0 6 * * *` UTC (runs typically start ~06:05 UTC); scheduled runs also redeploy contracts |
| staging-public, staging-internal, testnet, mainnet | Deploy Network | 333053201 | the `image_tag` input, e.g. `6.0.0-rc.4` | manual `workflow_dispatch` only |
| devnet | none | | no deploy workflow on main | |

> For T before 2026-09-10, staging deployed from its own nightly workflows: "Deploy to staging public" (id 333054183) and "Deploy to staging internal" (id 333056854), whose run `headSha` is the deployed commit. For T before the repo split (August 2026), run history lives in the old repos instead: `AztecProtocol/aztec-packages-private` for next-net/devnet/staging-internal, `AztecProtocol/aztec-packages` for staging-public. Same procedure, substitute the repo in `-R`.

Re-confirm ids/branches with `gh workflow list -R aztec-labs-eng/aztec-node --all` and the YAML under `.github/workflows/`.

## Procedure

The subagent runs these steps against `aztec-labs-eng/aztec-node` (or the pre-split repo when T predates the split).

1. **Find the deploy run live at time T:**
   ```bash
   gh run list -R aztec-labs-eng/aztec-node --workflow <id> --limit 30 \
     --json databaseId,displayTitle,conclusion,createdAt \
     --jq '.[] | "\(.createdAt) \(.conclusion) run=\(.databaseId) \(.displayTitle)"'
   ```
   Deploy Network serves several networks. Its runs from 2026-10-08 on are titled `Deploy Network (<image_tag> to <network>)`; for older runs, and for Deploy Next Net, read the network and tag from the log (step 2). Take the most recent run for the network with conclusion `success` at/before T; skip `failure`/`cancelled`. Confirm it finished before the event you're investigating:
   ```bash
   gh run view <run-id> -R aztec-labs-eng/aztec-node --json startedAt,updatedAt,conclusion
   ```

2. **Map the run to a commit.** The run's `headSha` is only the branch tip the workflow ran from, not the deployed code. Read what the run deployed from its log, then resolve the image tag's git tag:
   ```bash
   gh run view <run-id> -R aztec-labs-eng/aztec-node --log | grep -m2 -E '[[:space:]]IMAGE_TAG: |Deploying network: '
   gh api repos/aztec-labs-eng/aztec-node/commits/v<image_tag> --jq .sha
   ```
   A private release's image tag `<ver>-private.<n>` comes from the git tag `private/v<ver>-private.<n>`.

3. **Inspect code at that commit (no clone needed):**
   ```bash
   gh api "repos/aztec-labs-eng/aztec-node/contents/<path>?ref=<sha>" \
     -H "Accept: application/vnd.github.raw+json"
   ```
   Read the actual file content at the ref — more reliable than commit-ancestry because fixes get ported across branches/repos with different hashes.

4. **Is fix X present?** Match by the *code change* or commit message, not the PR number — PR numbers differ across the pre-split repos (e.g. public #23940 == private port #23975). Do not rely on commit SHA either, these may change when squashing. For an ancestry check instead:
   ```bash
   gh api "repos/aztec-labs-eng/aztec-node/compare/<base>...<head>"
   ```
   and read `status` (`ahead`/`identical` ⇒ base contains head).

5. **(Optional) Live cross-check** via GCP Cloud Logging (project `testnet-440309`, namespace = the network name, e.g. `next-net`): grep for the bug's runtime log signature over the last ~24h; its absence while the namespace is actively logging corroborates the fix is live. This is the `network-logs` agent's domain — delegate to it for a thorough query.

## Caveats
- Deploy runs deploy **prebuilt images** published by the release workflow for the image tag's git tag; they build nothing. A run's `headSha` says nothing about the deployed code (step 2).
- Always check run `conclusion`; never assume "the nightly for date D" succeeded. A string of failed Deploy Network runs leaves the network on an older image than the latest run names, and a failed Deploy Next Net run leaves next-net torn down until the next successful one.
