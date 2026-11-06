# Aztec TypeScript Monorepo Development Guide

## Overview

Aztec is a privacy-first Layer 2 zk-rollup on Ethereum that supports smart contracts with both private and public state and execution.

Private execution happens on the user device. A **transaction** sent by the user contains a set of note commitments, nullifiers, logs, and public function calls, along with a zk-proof that proves correct execution. These transactions are added to **blocks** by a **sequencer**, who also executes any public calls from the transaction. Blocks are grouped into **checkpoints** and submitted to L1. Checkpoints are grouped into **epochs** and proven via a rollup validity proof, which gets verified on L1.

An Aztec **node** syncs L2 state and serves RPC requests. A node may also act as a **validator** by staking, in which case it may be selected as a **proposer** to assemble transactions into blocks, and as part of a **validation committee** to participate in consensus by signing attestations. A **prover** node generates validity proofs for epochs and submits them to L1.

## Project Structure

- **TypeScript monorepo** with each folder being a package
- **Working directory**: `yarn-project`
- **Main branch**: `main`

## Native Tools Over Bash

Prefer native tools over bash equivalents—they don't require permissions and provide better output:

- **Glob** instead of `ls`, `find`, or `tree` for listing/finding files
- **Read** instead of `cat`, `head`, `tail` for reading files
- **Grep** instead of `grep`, `rg` for searching content
- **Edit/Write** instead of `sed`, `awk`, `echo >` for modifying files

## Bash Command Rules

**NEVER `cd` before running a command.** The working directory is already `yarn-project`. Run commands directly:

```bash
# GOOD
yarn build
yarn workspace @aztec-labs/sequencer-client test src/file.test.ts
git diff HEAD

# BAD — never do this
cd /home/santiago/Projects/aztec-3/yarn-project && yarn build
cd /home/santiago/Projects/aztec-3 && git diff HEAD
```

Git commands work from any subdirectory of a repo—there is no need to `cd` to the git root. The Bash tool already runs in `yarn-project`, so never prefix commands with `cd` to `yarn-project` or the git root.

**NEVER append `; echo "EXIT: $?"` or similar** to any command. The Bash tool already reports exit codes directly.

## Essential Workflow

### When to Run Bootstrap

**ALWAYS** run `./bootstrap.sh` from `yarn-project` (not the git root) when:

- Pulling new changes that have modifications outside `yarn-project`
- Switching branches with changes from outside `yarn-project`
- Rebasing on a branch that has changes outside `yarn-project`
- The toolchain pins moved, or anything feeding the code generation changed

```bash
./bootstrap.sh
```

Bootstrap takes several minutes to run. Be patient.

### Compile Before Testing

Always build the full project from the `yarn-project` root—never run `tsgo` directly and never build specific packages. `yarn build` recompiles TypeScript only; when generated inputs may have moved (a toolchain pin bump, a `constants.nr` change), run `./bootstrap.sh` instead, or `constants/src/constants.gen.ts` stays stale and the build reports members that the current release does have:

```bash
yarn build        # TypeScript only
./bootstrap.sh    # code generation + TypeScript
```

### Before Committing (Quality Checklist)

Run from `yarn-project`:

1. **Build**: Ensure entire project compiles (`yarn build`)
2. **Format**: Run on entire project (`yarn format`)
3. **Lint**: Run on entire project (`yarn lint`)
4. **Test**: Run unit tests for modified files
5. **Document**: Add an entry to `CHANGELOG-DEVELOPERS.md` or `CHANGELOG-OPERATORS.md`, at the repo root, for any change developers or operators will notice

## Testing

Use `yarn workspace` to run tests without changing directories:

```bash
yarn workspace @aztec-labs/<package-name> test src/file.test.ts                 # Run test file
yarn workspace @aztec-labs/<package-name> test src/file.test.ts -t 'test name'  # Run specific test
```

### Capturing Test Output

For long-running tests or verbose output, redirect to a temp file and use native tools to examine:

```bash
yarn workspace @aztec-labs/<package-name> test src/file.test.ts > /tmp/test-output.log 2>&1
```

Then use **Read** or **Grep** to examine `/tmp/test-output.log`. Never use `| tail` or `| head` to limit output—use native tools instead.

### End-to-End Tests

- Never run multiple e2e tests in parallel
- E2e tests take significant time
- Tests log "Running test TEST NAME" to track progress

```bash
yarn workspace @aztec-labs/end-to-end test:e2e e2e_something.test.ts
```

### Sequential Testing (Port Conflicts)

Some packages (e.g., `ethereum`) require sequential execution. The `test` script already passes `--maxWorkers`, which jest refuses to combine with `--runInBand`, so set the worker count instead:

```bash
JEST_MAX_WORKERS=1 yarn workspace @aztec-labs/<package-name> test
```

### Test Logging

Do not assert ordinary log messages, levels, or logger calls in application tests. Test logging only for structured events
that tests or operators rely on, or for payload size and serialization requirements such as transaction receipt logs.
Match structured fields rather than message prose.

```bash
LOG_LEVEL=verbose yarn workspace @aztec-labs/<package-name> test src/file.test.ts  # Recommended
LOG_LEVEL="debug; info: json-rpc, simulator" yarn workspace @aztec-labs/<package-name> test src/file.test.ts    # More detail
# Available levels: trace, debug, verbose, info, warn

# Module-specific logging
LOG_LEVEL='info; debug:sequencer,archiver' yarn workspace @aztec-labs/<package-name> test src/file.test.ts
```

## Format & Lint

**IMPORTANT**: These commands are run from the root of `yarn-project`, NOT the git root.

### Style

- **Line width**: 120 characters (`printWidth: 120` in `.prettierrc.json`). Wrap **everything** at 120 — code, inline comments, and JSDoc/block comments alike. Do not wrap at 80, 90, or 100 out of habit. Prettier does not reflow comment bodies, so an under-wrapped JSDoc paragraph will sit at ~90 chars forever unless you wrote it at 120 to begin with.

### Format

```bash
yarn format                             # All packages
yarn format <package>                   # Single package (faster)
yarn format --check                     # Check only, no changes
```

### Lint

```bash
yarn lint                               # Run this before pushing
yarn lint <pkg1>                        # Single package (faster)

```

<typescript_style>
TypeScript style rules and the table of `@aztec-labs/foundation` helpers live in `yarn-project/.claude/rules/`
(`typescript-style.md`, `foundation-helpers.md`). Claude Code loads them when you work on a `.ts` file; if you are
planning TypeScript changes before opening one, or your tooling does not load `.claude/rules/`, read both files first.
</typescript_style>

<ci_config>
When a test intermittently fails but shouldn't block CI, edit `.test_patterns.yml` (at the git root, not in yarn-project) and add an entry under `tests:` with `retry: true` and `owners`. A matching failing test is retried once: a pass on the retry is a flake, which alerts the owners in #aztec3-ci Slack and doesn't fail CI, while a second failure still fails the build. Without `retry: true` the first failure fails the build. With `error_regex`, the entry applies only when the output matches. `skip: true` disables the test entirely (avoid unless constantly failing).
</ci_config>

## Dependency Management

After modifying any `package.json`:

```bash
yarn && yarn prepare
```

`yarn prepare` regenerates the `references` array in every workspace `tsconfig.json` from the `dependencies` field via `@monorepo-utils/workspaces-to-typescript-project-references`. Never hand-edit the `references` array — the next `yarn prepare` will overwrite any manual changes, and forgetting to run it leaves `tsc -b` incremental builds in an inconsistent state.

## Key Packages

### Server (Node)

Packages that run on Aztec network nodes:

- **aztec-node**: Main entrypoint for running an Aztec node, integrates all server components
- **sequencer-client**: Builds blocks from pending transactions and coordinates with validators
- **validator-client**: Handles block validation and attestation signing for consensus
- **prover-node**: Standalone prover node that generates proofs for epoch proving
- **prover-client**: Orchestrates proof generation, manages proving broker and queues
- **archiver**: Indexes and stores L2 block data fetched from L1 for historical queries
- **world-state**: Maintains the global Merkle tree state (note hashes, nullifiers, public data)
- **p2p**: Peer-to-peer networking layer using libp2p for transaction and block propagation
- **slasher**: Subsystem for detecting and collecting slashable offenses

### Client (Wallet/PXE)

Packages that run on user devices:

- **pxe**: Main client-side library for orchestrating private tx execution and proving
- **aztec.js**: JavaScript SDK for building dApps, interacting with contracts and accounts
- **accounts**: Sample account contract implementations (ECDSA, Schnorr, etc.)
- **key-store**: Manages user's private keys and key derivation for the PXE
- **entrypoints**: Transaction entrypoint implementations for account abstraction

### Shared

Core libraries used by both server and client:

- **stdlib**: Protocol-level types (transactions, blocks, proofs) and domain interfaces
- **foundation**: Low-level utilities (crypto primitives, logging, serialization, async helpers)
- **constants**: Protocol constants shared between TypeScript and Noir circuits
- **simulator**: ACIR/AVM circuit simulation for both private and public execution
- **protocol-contracts**: Canonical protocol contracts (registries, fee contracts, etc.)
- **noir-protocol-circuits-types**: TypeScript bindings for Noir protocol circuits
- **bb-prover**: Barretenberg prover integration for generating ZK proofs
- **ethereum**: L1 contract interactions, deployment, and rollup publishing
- **kv-store**: Key-value storage abstraction (LMDB for server, IndexedDB for browser)

## Git & PR Guidelines

### Branch Naming

Prefix branches with author initials (derived from `git config user.initials` or `git config user.name`):

```
ab/feature-name
jd/fix-something
```

Conventional commit types, branch strategy, and base-branch detection live in the root `CLAUDE.md` under `<git_workflow>`. The sections below cover only yarn-project-specific additions.

### Port Commits

When porting PRs between branches, include reference to original PR(s) in the PR body. Use the exact same commit message with the original PR number.

### Fixing PRs

During development just create normal commits. Only amend when explicitly asked or when using the `/fix-pr` skill on a PR targeting `main`.

```bash
git add .
git commit -m "fix: address review feedback"
git push
```

### Breaking Changes

1. Add an entry to `CHANGELOG-DEVELOPERS.md` or `CHANGELOG-OPERATORS.md`, at the repo root, saying how to migrate
2. Document breaking changes in PR description

### PR Descriptions

Do not use checklists (`- [ ]`) in PR descriptions unless explicitly requested—use regular bullet points instead.

### CI Labels

- **`ci-no-fail-fast`**: Run all tests even if some fail (useful for surveying multiple failures)
