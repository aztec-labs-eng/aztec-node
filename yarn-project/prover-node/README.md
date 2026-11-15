# Prover Node

The prover node works on generating epoch proofs for checkpoints that have been sequenced (submitted to L1). The proofs get submitted to the L1 rollup contract. The prover node needs an Aztec validator/full-node to access the canonical chain view. The prover node starts proving work on a checkpoint immediately when it lands on L1, it doesn't wait for the epoch to close. This is called **optimistic proving**.

This document describes the internal architecture. Paths are relative to `yarn-project/prover-node/src`.

## Contents

1. [Background](#background)
2. [Components](#components)
3. [Proving one epoch](#proving-one-epoch)
4. [States](#states)
5. [When things do not go to plan](#when-things-do-not-go-to-plan)
6. [The `startProof` and `getJobs` API](#the-startproof-and-getjobs-api)
7. [Proving blocks before their checkpoint lands](#proving-blocks-before-their-checkpoint-lands)
8. [Configuration](#configuration)
9. [Logs, metrics and failure uploads](#logs-metrics-and-failure-uploads)
10. [Design decisions](#design-decisions)
11. [Known limitations](#known-limitations)

## Background

A **checkpoint** is the set of blocks built in one L2 slot, posted to L1 together. An **epoch** is a fixed number of
consecutive slots. The **proven tip** is the highest block L1 has accepted a proof for.

L1 accepts a proof of an epoch until the **proof-submission window** closes, at the start of epoch
`E + proofSubmissionEpochs + 1`. After that the epoch is **expired**.

An epoch proof covers the first `k` checkpoints of an epoch.

- A **full proof** covers every checkpoint of an epoch that has ended. L1 records it per prover and rewards every
  prover that submits one inside the window.
- A **partial proof** covers a prefix of an epoch that may still be open. It moves the proven tip. L1 does not count
  it as that prover's full proof.

Because of partial proofs, the proven tip can pass an epoch for which this prover holds no full proof. This document
calls that a **covered epoch**. The prover node still proves it in full while the window is open.

Proving has two levels:

- **Block-level proofs**, one set per checkpoint: transaction proofs, a block root per block, block merges, and one
  inbox parity proof. They need the checkpoint's transactions and a world-state fork per block.
- **The top tree**, one per epoch proof: a checkpoint root per checkpoint, merged up to the epoch root.

Proving jobs run on agents that take them from the **proving broker**. The broker identifies a job by its epoch, its
type and a hash of its inputs, so a job requested twice is proved once.

## Components

| Component | File | What it owns |
| --- | --- | --- |
| `ProverNode` | `prover-node.ts` | Builds the others, starts and stops them in order, serves the RPC API |
| `CheckpointFollower` | `checkpoint-follower.ts` | The block stream and the cursor of processed checkpoints |
| `CheckpointStore` | `checkpoint-store.ts` | One `CheckpointProver` per checkpoint the node may still prove |
| `CheckpointProver` | `job/checkpoint-prover.ts` | Block-level proving of one checkpoint |
| `SessionManager` | `session-manager.ts` | Every `EpochSession`, and the decision to create, keep or replace one |
| `EpochSession` | `job/epoch-session.ts` | One attempt to prove and publish a range of slots |
| `TopTreeJob` | `job/top-tree-job.ts` | One top-tree proving run |
| `ProofPublishingService` | `proof-publishing-service.ts` | The queue of finished proofs waiting to go to L1 |
| `ProverNodePublisher` | `prover-node-publisher.ts` | One L1 submission |
| `EpochProofStatus` | `epoch-proof-status.ts` | Reads of what L1 has proven |
| `EpochExpirySweep` | `epoch-expiry-sweep.ts` | Removal of expired epochs |
| `FailureUploader` | `failure-uploader.ts` | Uploads of failed proving data |
| `EarlyBlockProver` | `early-block-prover.ts` | Optional proving of blocks before their checkpoint lands |

Who calls whom:

```
archiver ──events──▶ CheckpointFollower ──▶ CheckpointStore ──▶ CheckpointProver ──jobs──▶ broker
                          │                      ▲                    │
                          │ callbacks            │ reads              │ block-level proofs
                          ▼                      │                    ▼
                     SessionManager ──────▶ EpochSession ──▶ TopTreeJob ──jobs──▶ broker
                                                 │
                                                 ▼ epoch proof
                                       ProofPublishingService ──▶ ProverNodePublisher ──▶ L1
```

Four things run concurrently, and each is serialised on its own:

- The block stream delivers one event at a time to `CheckpointFollower`.
- `SessionManager` runs every reconcile on one queue.
- `ProofPublishingService` runs every drain on another queue, so at most one L1 submission is in flight.
- `EpochExpirySweep` and the session manager's tick each run on a timer that never overlaps itself.

## Proving one epoch

This is what happens when nothing goes wrong.

1. The archiver reports a new checkpointed tip. `CheckpointFollower` receives a `chain-checkpointed` event.
2. The follower walks from its cursor to the tip. For each checkpoint it collects what proving needs (the previous
   block header, the checkpoint's L1-to-L2 messages, the previous archive sibling path) and registers the
   checkpoint with `CheckpointStore`.
3. The store creates a `CheckpointProver`, which starts at once. It fetches the checkpoint's transactions,
   re-executes them block by block, and enqueues the block-level proving jobs.
4. The follower tells `SessionManager` that the epoch has a new checkpoint. The manager runs a reconcile. The epoch
   has not ended, so no session is created.
5. Steps 1 to 4 repeat for each checkpoint. Block-level proving runs while the epoch is still open.
6. The epoch ends. On the next checkpoint event or tick, the manager finds that the epoch is complete and that the
   store holds every checkpoint the archiver reports for it. It creates a full `EpochSession` over those provers.
7. The session runs a `TopTreeJob`, which proves each checkpoint root as that checkpoint's block-level proofs
   arrive, and then the merges and the epoch root.
8. The session hands the epoch proof to `ProofPublishingService`.
9. The service waits until the block before the proof's first block is proven, then submits the proof through a
   `ProverNodePublisher`.
10. L1 accepts the proof and the session ends `completed`. The archiver reports the new proven tip, and the next
    tick moves on to the next epoch.
11. When the epoch expires, `EpochExpirySweep` removes its provers from the store.

A session holds a fixed list of provers, taken from the store when the session is created. It never changes the
list. When the store's content for the session's slots changes, the manager replaces the session.

## States

### `CheckpointProver`

A prover has three flags.

| Flag | Set when | Meaning |
| --- | --- | --- |
| `completed` | Every block is re-executed and its jobs are enqueued | Proofs may still be pending |
| `failed` | Block-level proving failed for any reason other than a cancel | The prover will never have its proofs |
| `cancelled` | The store removed the prover (prune, expiry, shutdown) | The prover is torn down |

A prover can be `completed` and later `failed` or `cancelled`. A cancelled prover is never marked failed afterwards.

### `EpochSession`

| State | Meaning |
| --- | --- |
| `initialized` | Created, top-tree job not started |
| `awaiting-checkpoints` | The top-tree job is preparing its inputs |
| `awaiting-root` | The top tree is proving. Block-level proofs of some checkpoints may still be pending |
| `publishing-proof` | The proof is with the publishing service |
| `completed` | The proof was published, or L1 already held it |
| `superseded` | Another proof of the same epoch was chosen instead |
| `cancelled` | The manager cancelled the session |
| `timed-out` | The proof-submission window closed first |
| `stopped` | The attempt failed while one of its provers was failed or cancelled |
| `failed` | The attempt failed while every prover was healthy |

The last six are final. `stopped` and `failed` differ in cause. A prover fails the same way for a genuine fault and
for a prune that removed its base block, so a `stopped` session says nothing about the epoch. A `failed` session
means the top tree or the L1 submission failed on its own.

### Publishing a proof

A proof handed to the publishing service ends with one of these outcomes.

| Outcome | Meaning | Session state |
| --- | --- | --- |
| `published` | L1 accepted the proof | `completed` |
| `already-submitted` | L1 already held this prover's proof of this length | `completed` |
| `superseded` | A longer proof of the epoch was chosen, or the proven tip passed a partial proof | `superseded` |
| `withdrawn` | The session was cancelled while the proof was queued | `cancelled` |
| `expired` | The window closed while the proof was queued | `timed-out` |
| `failed` | A pre-check failed, the transaction reverted, or it was not mined in time | `failed` or `stopped` |

Among the proofs of one epoch whose predecessor block is proven, the service publishes the one that ends at the
highest block. A full proof is published even when the proven tip is already past it, because L1 rewards it. A
partial proof in that position is `superseded`.

## When things do not go to plan

### A checkpoint is pruned

The follower receives `chain-pruned` with the highest surviving block.

- The store cancels and removes every prover whose last block is above that block.
- The follower moves its cursor back to one below the checkpoint that holds that block, so a replacement checkpoint
  with the same number is registered again.
- The manager cancels every session that used a removed prover. If a session can be built over what is left, it
  starts one with the same slot range.

When the replacement checkpoint arrives it gets a new prover, even if its content is identical. Jobs the broker has
already finished for identical content are reused. The session is replaced once more, now including the new prover.

If the archiver has no data for the surviving block, the prune throws before changing anything, and the block stream
delivers it again.

### Registering a checkpoint fails

Registration throws when any of its steps fails:

- The checkpoint or its predecessor is missing from the archiver.
- The message source returns messages that do not match the checkpoint's inbox rolling hash.
- World state cannot sync to the checkpoint.

The follower leaves its cursor before that checkpoint and does not acknowledge the event. The block stream delivers
the event again on its next poll, and the follower retries from the same checkpoint.

### A checkpoint prover fails

The prover is marked failed and its checkpoint data is uploaded (see [failure uploads](#failure-uploads)).

- A session waiting on it ends `stopped` and is removed.
- No session is created over a failed prover. The epoch is tried again only after a prune and re-registration
  replace the prover.

### The top tree or the L1 submission fails

The session ends `failed`. The manager keeps a `failed` full session, so the same checkpoints are not proven again to
the same failure, and uploads the session's data once. A change to the epoch's checkpoints replaces it.

### A proof lands before the epoch ends

A partial proof, from this node or another prover, moves the proven tip over an epoch that this prover holds no full
proof of. The manager still opens a full session for such an epoch, with three differences:

- Only the tick opens it. A checkpoint or prune event does not.
- Before opening, the manager reads from L1 whether this prover's full proof of the epoch is registered. It skips
  the epoch if it is, or if L1 cannot be read. The answer is reused for one L2 slot.
- The next unproven epoch goes first. While that epoch is complete and has no session, one session slot is kept
  free for it.

### The node restarts

`CheckpointFollower` places its cursor before it starts the block stream.

- It finds the last epoch that is fully proven. If that epoch is still inside its proof-submission window, it goes
  back to the last epoch whose window has closed, because this prover may hold no full proof of the epochs in
  between.
- The cursor is the last checkpoint at or before that epoch's last slot.
- `EpochExpirySweep` starts from the same epoch.

The catch-up then registers every later checkpoint, with these exceptions for a whole epoch:

- The epoch is expired.
- The epoch is fully proven and the node has full-epoch proving disabled.
- The epoch is fully proven and L1 already holds this prover's full proof of it.
- The epoch is fully proven and world state has pruned a snapshot that one of its unregistered checkpoints needs.

If the cursor is more than `(proofSubmissionEpochs + 1) * epochDuration` checkpoints behind the tip, the older ones
are skipped without being fetched.

### The proof-submission window closes

- A session's own timer cancels it, and it ends `timed-out`.
- A queued proof resolves `expired`. A submission already sent to L1 is given until the same moment to be mined.
- No new session is opened for the epoch.
- `EpochExpirySweep` removes the epoch's provers and releases its chonk-verifier cache entries. The sweep runs on a
  timer, so it also runs while no chain events arrive.

### Too many sessions

`PROVER_NODE_MAX_PENDING_JOBS` limits how many sessions run at once. At the limit, the manager does not open a full
session and tries again on a later reconcile. `startProof` throws.

### Shutdown

`ProverNode.stop` stops the follower and the sweep first, then the sessions, then publishing, then the provers.

- Sessions are cancelled without aborting their broker jobs, so a restarted node reuses them.
- The publishing service waits up to 30 seconds for a submission in flight.

## The `startProof` and `getJobs` API

`startProof(epoch)` asks for a proof of the checkpoints the store holds for the epoch right now. It returns a session
id at once and does not wait for the proof.

- It creates a partial session from the epoch's first slot to the slot of the last stored checkpoint.
- If a running session already proves exactly that, it returns that session's id.
- It throws when the store holds no checkpoint of the epoch, when the proven tip already covers them, when one of
  their provers has failed, or when the session limit is reached.

`getJobs()` lists the sessions the manager holds, with their state. That includes full sessions that ended
`completed` or `failed`, until their checkpoints change or expire.

`PROVER_NODE_DISABLE_FULL_EPOCH_PROVING` makes the node prove only what `startProof` asks for.

## Proving blocks before their checkpoint lands

A partial proof is usually requested right after a checkpoint lands, and then waits for that checkpoint's block-level
proofs. With `PROVER_NODE_EARLY_BLOCK_PROVING` set, `EarlyBlockProver` starts those proofs when each block is
proposed.

1. The follower passes each move of the proposed tip to the early prover.
2. The early prover fetches the new blocks. For each slot it runs the blocks, in order, through a blocks-only
   sub-tree, which enqueues each block's jobs up to its block root.
3. When the checkpoint lands, the node proves it through a `CheckpointProver` as usual. That prover requests jobs
   with the same inputs, and the broker serves them from the work already started.

The early proofs are never handed to anything else, which is what keeps the rest of the node unaffected:

- A block pruned before its checkpoint lands has its slot dropped. Its jobs are never requested again, so they
  cannot reach an epoch proof. The slot is proven again from its first block when the proposed tip moves.
- A failure in early proving is logged and the slot is left to its checkpoint.
- Early proving never aborts a broker job, because a `CheckpointProver` may be waiting on the same one.
- At most four slots are in progress. A slot normally leaves when its checkpoint lands.

What it costs:

- Each block's transactions are executed once more when the checkpoint lands.
- The jobs of a pruned block run to completion on the agents.
- The broker keeps a job that failed after all its retries. If a job started early fails that way, the
  `CheckpointProver`'s request for the same job fails with it, and the prover is marked failed.

The time from a block reaching the early prover to its block root proof is logged, for blocks whose proofs are ready
before their checkpoint lands.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROVER_NODE_POLLING_INTERVAL_MS` | 1000 | Interval of the block stream, the session tick and the expiry sweep |
| `PROVER_NODE_MAX_PENDING_JOBS` | 10 | Most sessions running at once. 0 removes the limit |
| `PROVER_NODE_TX_GATHERING_TIMEOUT_MS` | 120000 | How long a prover waits for a checkpoint's transactions |
| `PROVER_NODE_FAILED_EPOCH_STORE` | unset | Where failed proving data is uploaded |
| `PROVER_NODE_DISABLE_PROOF_PUBLISH` | false | Estimate the L1 cost of each proof without submitting it |
| `PROVER_NODE_DISABLE_FULL_EPOCH_PROVING` | false | Prove only the epochs requested through `startProof` |
| `PROVER_NODE_EARLY_BLOCK_PROVING` | false | Start block-level proving when a block is proposed |
| `PROVER_NODE_PROOF_SUBMISSION_TARGET_ADDRESS` | rollup address | L1 address the proof transaction is sent to |

`PROVER_NODE_FAILED_EPOCH_STORE` also needs a data directory, the L1 chain id and the rollup version. The node refuses
to start without them.

## Logs, metrics and failure uploads

### Loggers

| Logger | Covers |
| --- | --- |
| `prover-node` | Start and stop |
| `prover-node:checkpoint-follower` | New checkpoints, skipped epochs, prunes |
| `prover-node:checkpoint-store` | Provers created and removed |
| `prover-node:session-manager` | Sessions opened, replaced and dropped, and why a full session was not opened |
| `prover-node:epoch-session` | One session's progress |
| `prover-node:proof-publishing-service` | Proofs queued, published, expired |
| `prover-node:l1-tx-publisher` | The L1 transaction |
| `prover-node:epoch-proof-status` | Failed reads of this prover's proof registration |
| `prover-node:epoch-expiry-sweep` | Expired epochs |
| `prover-node:failure-uploader` | Uploads |
| `prover-node:early-block-prover` | Early proving, including the time to each block root proof |

### Metrics

| Metric | Recorded by |
| --- | --- |
| `aztec.prover_node.job_duration`, `job_checkpoints`, `job_blocks`, `job_transactions` | A session that published a proof |
| `aztec.prover_node.checkpoint_processing.duration`, `checkpoint_blocks`, `checkpoint_transactions` | A prover that finished re-executing its checkpoint |
| `aztec.prover_node.block_processing.duration` | A prover, per block |
| `aztec.prover_node.checkpoint_proving.duration` | A prover whose block-level proofs are ready |
| `aztec.prover_node.blob_processing.last_duration` | A top-tree job |
| `aztec.prover_node.active_checkpoints`, `active_epoch_sessions` | Gauges of the store and the manager |
| `aztec.prover_node.proof_submission_unaffordable_count` | The publishing service, when no publisher can pay |
| `aztec.prover_node.estimated_submission.*` | The publisher, when publishing is disabled |
| `aztec.prover_node.rewards_per_epoch`, `rewards_total` | Read from the rollup contract |

### Failure uploads

With `PROVER_NODE_FAILED_EPOCH_STORE` set, the node uploads what is needed to run a failed attempt again offline,
together with a world-state and archiver backup.

- When a `CheckpointProver` fails, its checkpoint is uploaded, provided the archiver still holds the checkpoint. A
  pruned checkpoint is not uploaded.
- When a full session ends `failed`, all its checkpoints are uploaded, once.

`downloadEpochProvingJob` fetches an upload. `rerunEpochProvingJob` proves an epoch from it and
`rerunCheckpointProvingJob` proves a single checkpoint.

## Design decisions

**A session is defined by slots, not by checkpoint numbers.** A reorg can replace the checkpoints of a slot range.
The range itself does not change, so a replaced session keeps it.

**Every session starts at the first slot of its epoch.** L1 accepts a proof when the checkpoint before its first
checkpoint is proven, and it accepts a range whose beginning is already proven. A proof that starts at the epoch's
first slot meets both conditions wherever the proven tip is by the time it is submitted.

**A pruned prover is removed, not kept.** Its re-execution reads world-state forks that the prune invalidates. What
is expensive, the finished proving jobs, survives in the broker.

**The publishing service owns L1 submission.** Several sessions can hold a proof of the same epoch. Choosing between
them and reading the proven tip happen in one serial queue, so only one transaction is sent.

**`stopped` and `failed` are told apart by the provers.** A prune reaches the node twice: as a chain event, and as a
failed world-state read inside a prover. The two are not ordered. The session does not ask which came first. It
asks whether any of its provers failed or was cancelled.

## Known limitations

- A failed `CheckpointProver` is not retried. A transaction fetch that times out leaves the epoch unproven by this
  node until a prune or a restart.
- A `failed` full session is not retried either, including when the cause was a transient L1 or archiver error.
- The tick opens the next unproven epoch and covered epochs. A later epoch that ended without a new checkpoint
  waits until the epoch before it is proven.
- A full session and a partial session over the same checkpoints can both prove the top tree. The publishing
  service publishes one of them.
- The publishing service marks the other proofs of an epoch `superseded` before the chosen one is on L1. If the
  chosen one then fails, nothing is published for the epoch.
- If the session manager throws while handling a prune, the prune is delivered again, finds no prover left to
  remove, and does not reach the session manager a second time.
- The broker proves block-level jobs before checkpoint roots. Checkpoints that land in the same epoch after a
  partial proof was requested therefore delay that proof's checkpoint roots.
