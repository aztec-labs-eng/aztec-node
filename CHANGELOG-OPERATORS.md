# Operator changelog

Changes node operators have to act on, or will notice: CLI flags and environment variables, changed defaults, keystore and Helm values, node RPC methods, artifact locations, and behaviour visible in their logs, metrics or sync. Internal refactors, tests and CI do not belong here, and neither does anything only contract, app or wallet developers see: those go in the [developer changelog](./CHANGELOG-DEVELOPERS.md).

Each release line keeps its own copy of this file on its own branch. This one is `v6`, which ships the 6.x line; the v7 line's copy is on the `main` branch. An entry belongs on every branch whose releases carry the change, which for a backport means both.

The published [operator changelog](https://github.com/AztecProtocol/aztec-packages/tree/next/docs/docs-operate/operators/reference/changelog) in aztec-packages is written from these entries at release time, so an entry here is the record, not a draft of one — write it for the operator who will read it, not for the reviewer of the PR.

## Format

One `###` heading per change, under the `## Unreleased` section, newest first. Name the flag or variable in the heading when there is one, and link the PR.

Give the before and after for anything an operator has configured, and a **Migration** line whenever the change needs action. A change that needs none says so.

A change to any of the following is breaking, and its entry says how to migrate:

- **P2P wire format**: gossip message encoding, topics, req/resp protocols, peer scoring. Nodes on the old and new version must still interoperate, or the PR must say they can't.
- **Database schema**: archiver, world state, p2p, and slasher stores. Bump the schema version and say whether nodes need a resync.
- **Node RPC API**: public and admin JSON-RPC methods, their params and return types.
- **Operator interface**: CLI flags, environment variables, config defaults, keystore format, Helm values.
- **Protocol**: block, checkpoint, or blob format; constants; circuits; L1 contract interactions and ABIs; slashing conditions.
- **Observability**: renamed or removed metrics and log fields that dashboards or alerts depend on.

```markdown
### `FOO_TIMEOUT_MS` replaces `FOO_TIMEOUT` ([#123](https://github.com/aztec-labs-eng/aztec-node/pull/123))

The timeout is now read in milliseconds, and the old name is no longer read at all: a node still
setting it starts with the default of 30s rather than the value it was given.

**Migration**: rename the variable and multiply the value by 1000.
```

## Unreleased

### The node stops sending L1 requests to RPC URLs that fall behind ([#587](https://github.com/aztec-labs-eng/aztec-node/pull/587))

With two or more URLs in `ETHEREUM_HOSTS`, the node used to send every request to the first one, and moved to the next only when a request failed. A URL that still answered but had fallen behind the chain kept getting all the traffic. The node now checks every URL's latest block every few seconds. It stops using a URL that falls behind the others or stops answering, and uses it again once it has caught up. A URL on a different L1 chain is never used, and the node logs an error naming it.

If every URL falls behind at once, the node keeps using all of them, in the order you listed them. The logs show `Demoted L1 RPC URL` when a URL is set aside and `Restored L1 RPC URL` when it is back.

The defaults should suit most setups. New variables tune the checks:

- `ETHEREUM_HOSTS_GRADER_INTERVAL_MS` (default 4000): how often each URL is checked.
- `ETHEREUM_HOSTS_GRADER_PROBE_TIMEOUT_MS` (default 1000): how long a check waits for an answer.
- `ETHEREUM_HOSTS_GRADER_MAX_BLOCKS_BEHIND` (default 2): how many blocks a URL may trail the others.
- `ETHEREUM_HOSTS_GRADER_THRESHOLD` (default 3) and `ETHEREUM_HOSTS_GRADER_WINDOW` (default 5): a URL is set aside after 3 bad checks among its last 5, and comes back after 3 good checks in a row.
- `ETHEREUM_HOSTS_GRADER_KEEP_DEMOTED` (default false): set to true to keep URLs that were set aside as a last resort, rather than not using them at all.

**Migration**: none. A node with a single URL in `ETHEREUM_HOSTS` behaves as before.

### Snapshot upload status through the admin API (`aztecAdmin_getSnapshotUploadStatus`) ([#713](https://github.com/aztec-labs-eng/aztec-node/pull/713))

`aztecAdmin_startSnapshotUpload(location, operationId?)` now accepts an optional caller-generated UUID.
Poll `aztecAdmin_getSnapshotUploadStatus(operationId)` for `capturing`, `uploading`, `succeeded`, or `failed`
(including an error). `capturing` covers the local database backups. `uploading` means the local copies are ready
and syncing has resumed; check readiness and sync catch-up before returning the node to a load balancer.
The node can serve traffic while the snapshot uploads. Capture failures also attempt to resume syncing;
check readiness before returning a failed operation's node to service.
Success means both snapshot data and its index entry have been published. Repeating a retained ID with the same
location does not start another upload; a different location is rejected. To retry a failed upload, use a new UUID.

Status is held in memory for up to 100 operations with least recently used eviction. An unrecognized ID, including
after a process restart or eviction, returns `unknown`; this does not mean the upload succeeded or failed.
Check the published snapshot before deciding whether to start another operation.

**Migration**: existing one-argument calls remain supported. To track uploads and recover from lost responses,
generate and save a UUID before calling start, then poll that UUID on the same node using the authenticated admin API.

### Blob filestore uploads retry transient storage errors

Blob uploads from proposers, validators and blob retrieval now share a retry policy: after the first failure,
retry after 1, 2, 4, 8 and 16 seconds. Existing blobs are skipped when retrying a partially successful batch.
Exhausted uploads log an error with the blob hashes and return failure rather than throwing. Startup healthcheck
uploads use the same retries but no longer fail node startup; periodic healthchecks continue after an outage,
without overlapping runs.

New metrics distinguish transient storage errors from requests that exhaust their retries:

- `aztec.blob_client.upload_attempt_count`: storage attempts, labelled by attempt outcome.
- `aztec.blob_client.upload_request_count`: upload requests, labelled by final outcome after retries.
- `aztec.blob_client.upload_duration`: request duration in milliseconds, including retries.

All three use `aztec.blob_client.upload_type` (`blobs` or `healthcheck`) and `aztec.status` (`success` or `failure`).
A blob request counts a batch, not individual blobs. Alert on failed blob upload requests to detect possible gaps.
Retries are in memory only: exhausted uploads and uploads interrupted by a restart are not queued for backfill.

**Migration**: none.

### Static setup calls are rejected, and `TX_PUBLIC_SETUP_ALLOWLIST` entries declare a minimum setup gas ([#701](https://github.com/aztec-labs-eng/aztec-node/pull/701))

Nodes now reject two more kinds of setup call, at gossip, RPC and block building. Pending-pool migration rejects them too, but reports every setup failure as `Setup function not on allow list`:

- **Static calls.** A static call cannot write state, so in setup it can only consume gas or fail. Every static setup call is now rejected with `Static setup calls are not allowed`, whatever function it targets. Before, the static flag was not checked.
- **Too little gas for setup.** An entry can declare the most gas its function can use in setup, for any calldata the entry allows. A tx is rejected, with `Gas limits leave setup less gas than its allowed functions need`, when its gas limits leave setup less than the sum over its setup calls. The three default entries (AuthRegistry `_set_authorized` and `set_authorized`, FeeJuice `_increase_public_balance`) now carry the gas they consume. Custom entries declare it with the new `l2=N` and `da=N` flags; a dimension left out is zero, and an entry with neither has no gas requirement. The node logs a warning at startup, and when the allow list is changed at runtime, for each custom entry without them.

```
# before: only address, selector and the os/rn/cl flags were checked
TX_PUBLIC_SETUP_ALLOWLIST=I:0x1234…:0xabcd1234:os+cl=4
# after: also require txs to leave setup at least this much gas for the call
TX_PUBLIC_SETUP_ALLOWLIST=I:0x1234…:0xabcd1234:os+cl=4+l2=40000+da=64
```

The node RPC method `aztec_getAllowedPublicSetup` returns the new `minGas` field on the entries that set it.

A peer that gossips a tx failing any setup allow list check, old or new, now gets the high-tolerance penalty instead of the mid-tolerance one. The allow list is local configuration, so peers running an older version or a different allow list relay such txs honestly. It now takes several times as many such rejections before a relayer is disconnected or banned, and each still counts briefly against its gossipsub score.

Only allow list functions that cannot revert for any calldata their entry allows. A failed setup call makes the whole tx invalid, so for example a token transfer that can fail on balance or authorization is not a safe entry.

**Migration**: existing allow list strings parse as before, except that `cl=N`, like the new `l2=N` and `da=N`, takes only a plain integer from 0 to 2^32-1. Before, it read only the leading digits, so `cl=4x` meant `cl=4` and `cl=1e3` meant `cl=1`; now the node fails to start with an `Invalid allow list entry` error. For each custom entry, measure the most gas its function can use in setup, for any calldata the entry allows, and declare it with `l2=N` and `da=N`; without them, txs whose gas limits leave too little for that call are still admitted. A custom entry that targets a `#[view]` function, which only works when called statically, no longer admits any tx: remove it. Older nodes reject the `l2=` and `da=` flags with an `unknown flag` error when they read their config, so do not put them in a network config shared with nodes that have not upgraded.

### HA validators sign again with an odd `VALIDATOR_HA_MAX_STUCK_DUTIES_AGE_MS` ([#669](https://github.com/aztec-labs-eng/aztec-node/pull/669))

An HA validator caps each signer call at half of `VALIDATOR_HA_MAX_STUCK_DUTIES_AGE_MS` when that is below `VALIDATOR_SIGNER_CALL_TIMEOUT_MS`. With an odd value, half of it was a fraction of a millisecond, and every signing failed at once with a `RangeError` saying the value is out of range. The cap is now rounded down to a whole millisecond. The default, two slots, is even and was not affected.

**Migration**: none.

### Prover nodes derive the default `WS_HISTORY_RETENTION` from the proof submission window ([#727](https://github.com/aztec-labs-eng/aztec-node/pull/727))

A node that leaves `WS_HISTORY_RETENTION` unset, along with the deprecated `WS_NUM_HISTORIC_CHECKPOINTS` and `WS_NUM_HISTORIC_BLOCKS`, used to keep `rolling:64` whatever its role. A prover node now keeps `rolling:max(64, (proofSubmissionEpochs + 1) * epochDuration)` instead, read from the rollup at startup, and logs the derived value at info. Other nodes still default to `rolling:64`. A prover configured with an explicit `rolling:N` below its proof submission window still fails at startup, and `archive` and `pinned` retention are unchanged.

**Migration**: none. A prover that set `WS_HISTORY_RETENTION` only to satisfy the startup check can unset it to follow the rollup's window.

### Prover nodes reject insufficient rolling `WS_HISTORY_RETENTION`

Prover nodes previously accepted rolling world-state retention shorter than the proof submission window, which could prune checkpoints still needed for proving after another prover's proof finalized. Startup now rejects `rolling:N` when N is less than `(proofSubmissionEpochs + 1) * epochDuration`, using the rollup's on-chain parameters. Non-prover nodes and archive or pinned retention are unchanged.

**Migration**: if startup rejects your retention setting, increase `WS_HISTORY_RETENTION` to the minimum printed in the error or use `archive`. This also applies to rolling retention configured through the deprecated `WS_NUM_HISTORIC_CHECKPOINTS` and `WS_NUM_HISTORIC_BLOCKS` variables. Increasing retention does not restore history already pruned; rebuild the world-state database if required checkpoints are missing.

### Prover nodes prove epochs that an early proof already covered ([#693](https://github.com/aztec-labs-eng/aztec-node/pull/693))

A proof that lands while its epoch is still open, such as an early-withdrawal partial proof requested through `startProof`, moves the proven tip past the epoch. L1 registers that proof as non-full and still rewards a full-epoch proof from every prover until the epoch's submission window closes. Prover nodes used to schedule from the proven tip alone, so they skipped such an epoch and lost its prover reward share and activity-score increase.

Prover nodes now prove such an epoch in full while L1 holds no full-epoch proof of it from their prover id, and catch-up after a restart no longer skips it. Expect extra proving work and an extra proof submission for each epoch covered this way. A node with `PROVER_NODE_DISABLE_FULL_EPOCH_PROVING` set still proves only the epochs requested through `startProof`.

Stopping a prover node no longer waits out its checkpoints' tx gathering, which could take up to `PROVER_NODE_TX_GATHERING_TIMEOUT_MS`: a stop cancels the gathering's retries and waits between them. A request already sent to a tx source still has to settle first, so a stalled node RPC can still delay the stop. A gather cut short by a stop or a prune logs `Retrieved N out of M txs for block` at `verbose` with `aborted: true` instead of at `warn`, and its missing txs no longer count toward `aztec.tx_collector.missing_txs_count`.

**Migration**: none.

### Startup L1 logs check reads from the node's latest checkpoint ([#683](https://github.com/aztec-labs-eng/aztec-node/pull/683))

At startup the archiver asked every URL in `ETHEREUM_HOSTS` for the Rollup's deployment event, and refused to start if any URL returned nothing or an error. A node on L1 full nodes needed `ARCHIVER_SKIP_HISTORICAL_LOGS_CHECK=true` even when restored from a recent snapshot.

It now asks each URL for the event of the latest checkpoint the node already holds, and only asks for the deployment event on a node with no checkpoints yet. A URL that answers with an error, including JSON-RPC error 4444 for pruned history, now only logs a warning, since requests move past it to the next URL. Startup still fails when a URL returns an empty result from a block it holds: such a URL hides logs from sync without an error, even alongside good URLs. A full node passes as long as it keeps logs back to the node's latest checkpoint, roughly the last 12 hours with a recent snapshot.

**Migration**: none required. If you set `ARCHIVER_SKIP_HISTORICAL_LOGS_CHECK=true` only to start against full nodes or a provider that answers 4444 for old ranges, you can remove it. If startup fails naming a URL, that L1 node returns empty results for logs it has pruned: upgrade it (Reth 2.8.0 and later answer with an error, including on snapshot-synced nodes), keep the Rollup and Inbox logs with Reth's `prune.segments.receipts_log_filter` (plus the Registry on sequencers and validators, whose slasher reads its deployment logs), or remove the URL.

### Max-gas gossip rejections no longer disconnect the relayer ([#582](https://github.com/aztec-labs-eng/aztec-node/pull/582))

The gossip max-gas check measures a transaction against this node's own read of the rollup's mana limit. In the minutes after governance raises that limit, a node that has not read the raise yet rejects transactions an updated peer is relaying honestly, and each rejection cost that peer a mid-tolerance penalty — six of them disconnected it. The penalty is now high tolerance, matching the other checks that fail on stale local state.

Only reachable around a governance change to the mana limit, and nothing to configure. Lagged rejections still count briefly against a peer's gossipsub score; they no longer get it dropped or banned.

### Validators check a checkpoint's opening block fees against L1 ([#517](https://github.com/aztec-labs-eng/aztec-node/pull/517))

The block that opens a checkpoint was re-executed with the gas fees from the proposal's own header, so nothing compared those fees with L1's mana minimum before the block was stored. Validators now price that block themselves, the way the proposer does, and compare.

Two rejection reasons are new in validator logs. `gas_fees_mismatch` means the proposal's fees differ from the price this node computes. `gas_fees_unavailable` means the price could not be read before the attestation deadline. Neither is slashable, since both rest on this node's own view of L1.

A node that lacks the data waits through forced archiver syncs until the deadline rather than attesting against an approximate price, so a node with a slow or lagging L1 endpoint may now withhold attestations where it used to give them. A run of `gas_fees_unavailable` points at your L1 endpoint, not at the proposer.

### Proving jobs retry when the machine fails, not only when the circuit does ([#532](https://github.com/aztec-labs-eng/aztec-node/pull/532))

Witness generation runs `noir-execute` as a child process. A child killed by the OOM killer, a child that could not be spawned, and an OS-level file error all surfaced as plain errors, which the proving agent counted as permanent: the broker failed the job after a single attempt, that failure sank the checkpoint prover, and the node never proved the epoch. These are now classified as retryable, so `PROVER_BROKER_JOB_MAX_RETRIES` applies and any agent can pick the job up again. A genuine constraint failure is still permanent after one attempt, as before.

A prover that was losing whole epochs to memory pressure will now work through them. The memory pressure is still worth fixing — retries make it survivable, not free.

### An invalid checkpoint on L1 no longer costs the honest proposals behind it ([#527](https://github.com/aztec-labs-eng/aztec-node/pull/527), [#529](https://github.com/aztec-labs-eng/aztec-node/pull/529))

A checkpoint with invalid attestations, posted at the number an honest proposer was about to use, did two kinds of damage. Every archiver compared it against the local proposed checkpoint of that number and evicted that proposal — and every proposal after it — before getting as far as rejecting the invalid one, so the next proposer built on the wrong parent and a slot was lost. Separately, a proposer that had built without a proposed parent never invalidated the bad checkpoint, so its own proposal could not land and the cleanup fell to a later slot.

Archivers now keep a proposed checkpoint from a later slot than the L1 one, and a proposer invalidates the bad checkpoint standing in its way. Visible as slots no longer lost after someone posts a checkpoint every node rejects. Nothing to configure.

### Relayers are no longer penalized for transactions that expire at a slot boundary ([#480](https://github.com/aztec-labs-eng/aztec-node/pull/480))

A gossiped transaction is checked for expiry against the receiver's own next-slot timestamp, which advances a full slot at each boundary. A relayer a slot behind could be penalized for a transaction it had seen as valid, and repeated hits pushed honest peers past the gossip, publish and graylist thresholds. A transaction that expired within the last slot is now ignored with no penalty; one expired by more than a slot is still rejected and its sender penalized.

Expect fewer peers scored down or dropped around slot boundaries.

### A node that restarts at a new address is reachable again ([#631](https://github.com/aztec-labs-eng/aztec-node/pull/631))

Peers replace a stored ENR only when they see a higher sequence number. A node that kept its peer ID but came back at a new IP published a sequence starting from zero, so peers kept the old record, kept dialling the old address, and the node drew no inbound connections until every peer expired it. The sequence is now seeded from the wall clock, so a restart always advertises a record peers accept. Bootnodes too.

Worth knowing if you run on a scheduler that hands a rescheduled node a new address, or on a dynamic IP. Nothing to configure.
