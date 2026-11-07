# Operator changelog

Changes node operators have to act on, or will notice: CLI flags and environment variables, changed defaults, keystore and Helm values, node RPC methods, artifact locations, and behaviour visible in their logs, metrics or sync. Internal refactors, tests and CI do not belong here, and neither does anything only contract, app or wallet developers see: those go in the [developer changelog](./CHANGELOG-DEVELOPERS.md).

Each release line keeps its own copy of this file on its own branch. This one is `main`, which ships as v7; the 6.x line's copy is on the `v6` branch. An entry belongs on every branch whose releases carry the change, which for a backport means both.

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

### Address entries in `TX_PUBLIC_SETUP_ALLOWLIST` require a deployed contract ([#706](https://github.com/aztec-labs-eng/aztec-node/pull/706))

A setup call that matches an address entry (`I:<address>:<selector>`) is now rejected, with `Setup function targets unknown contract`, when no contract is deployed at that address. Before, the node admitted the tx without checking, and its setup then failed when a proposer ran it. Class entries already required a deployed contract.

Standard contracts, such as the AuthRegistry targeted by the default entries, are exempt: the node treats them as deployed from network start and does not check for them. Protocol contracts such as FeeJuice exist from genesis and pass the check.

**Migration**: none. An address entry for a contract that is not yet deployed admits no tx until the contract is deployed.

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

**Migration**: existing allow list strings parse as before. For each custom entry, measure the most gas its function can use in setup, for any calldata the entry allows, and declare it with `l2=N` and `da=N`; without them, txs whose gas limits leave too little for that call are still admitted. A custom entry that targets a `#[view]` function, which only works when called statically, no longer admits any tx: remove it. Older nodes reject the `l2=` and `da=` flags with an `unknown flag` error when they read their config, so do not put them in a network config shared with nodes that have not upgraded.

### Prover nodes prove epochs that an early proof already covered ([#693](https://github.com/aztec-labs-eng/aztec-node/pull/693))

A proof that lands while its epoch is still open, such as an early-withdrawal partial proof requested through `startProof`, moves the proven tip past the epoch. L1 registers that proof as non-full and still rewards a full-epoch proof from every prover until the epoch's submission window closes. Prover nodes used to schedule from the proven tip alone, so they skipped such an epoch and lost its prover reward share and activity-score increase.

Prover nodes now prove such an epoch in full while L1 holds no full-epoch proof of it from their prover id, and catch-up after a restart no longer skips it. Expect extra proving work and an extra proof submission for each epoch covered this way. A node with `PROVER_NODE_DISABLE_FULL_EPOCH_PROVING` set still proves only the epochs requested through `startProof`.

Stopping a prover node no longer waits out its checkpoints' tx gathering, which could take up to `PROVER_NODE_TX_GATHERING_TIMEOUT_MS`: a stop cancels the gathering's retries and waits between them. A request already sent to a tx source still has to settle first, so a stalled node RPC can still delay the stop. A gather cut short by a stop or a prune logs `Retrieved N out of M txs for block` at `verbose` with `aborted: true` instead of at `warn`, and its missing txs no longer count toward `aztec.tx_collector.missing_txs_count`.

**Migration**: none.

### Nightly tags from `main` are now `v7.0.0-nightly.<date>` ([#656](https://github.com/aztec-labs-eng/aztec-node/pull/656))

`main` has moved to the 7.0.0 line, and the 6.x line now lives on the `v6` branch, which cuts its own nightlies. Both are tagged every night, so `v6.1.0-nightly.20261105` and `v7.0.0-nightly.20261105` both exist and are different code.

**Migration**: if you track nightlies, check which line you are pulling. Anything following the 6.x series wants the `v6.1.0-nightly.<date>` tags and the images built from them. `v7.0.0-nightly.<date>` is the next major, not a newer build of what you are running.

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
