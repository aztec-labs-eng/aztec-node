---
name: network-logs
description: Query and analyze logs from live Aztec network deployments on GCP Cloud Logging
argument-hint: <natural language query, e.g. "has testnet started producing blocks?">
---

# Network Log Analysis

Query live network logs in the current session. Delegate only when the user explicitly requests it.

## Usage

1. **Parse the user's query** to extract:
   - **Namespace**: The deployment to query (e.g., `testnet`, `devnet`, `mainnet`, or a custom namespace like `prove-n-tps-real`). If not specified, default to `testnet`.
   - **Intent**: What they want to know (block production, errors, proving status, specific pod logs, etc.)
   - **Time range**: How far back to look (default: 10 minutes). For relative references ("last 3 hours"), convert to a freshness value. For **absolute dates** ("March 11th", "yesterday"), use `timestamp >= start` and `timestamp < next-day-start` so fractional-second events are included. Use the current date to resolve relative day references.
   - **Scope**: Specific pods, severity levels, or modules to focus on.

2. **Read the shared query guidance** in [network-logs.md](../../agents/network-logs.md): the execution/output rules, cluster mapping, and recipes relevant to the question. If delegation was requested, pass this reference and the query scope to the agent.

3. **Keep raw results outside the conversation.** Use installed tools such as `gcloud`, `jq`, and `rg`; do not create a wrapper or install dependencies. Save broad query results to a unique temporary file, then return counts, selected fields, and small samples. Pipes and redirects are allowed. The shared guidance includes commands for previewing, grouping, and expanding saved records.

4. **Investigate progressively.** Start with a narrow time range and component, then follow specific jobs, pods, or events. Reuse saved results before querying overlapping windows. Keep query scope, coverage, caps, and file references with the findings so partial results are not mistaken for a complete history.

## Do NOT

- Do NOT guess at log contents — always query live data
- Do NOT dump large JSON records or repeated messages into context; expand relevant records on demand
- Do NOT infer absence from a capped query or exclude lifecycle/info logs when investigating a failure
- Do NOT assume a namespace when the request points to multiple deployments; otherwise use the `testnet` default above
