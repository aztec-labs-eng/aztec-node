# Operator changelog

Changes node operators have to act on, or will notice: CLI flags and environment variables, changed defaults, keystore and Helm values, node RPC methods, artifact locations, and behaviour visible in their logs, metrics or sync. Internal refactors, tests, CI, and changes that only reach contract or client developers do not belong here — those are the [developer migration notes](https://github.com/AztecProtocol/aztec-packages/blob/next/docs/docs-developers/docs/resources/migration_notes.md).

Each release line keeps its own copy of this file on its own branch. This one is `main`, which ships as v7; the 6.x line's copy is on the `v6` branch. An entry belongs on every branch whose releases carry the change, which for a backport means both.

The published [operator changelog](https://github.com/AztecProtocol/aztec-packages/tree/next/docs/docs-operate/operators/reference/changelog) in aztec-packages is written from these entries at release time, so an entry here is the record, not a draft of one — write it for the operator who will read it, not for the reviewer of the PR.

## Format

One `###` heading per change, under the `## Unreleased` section, newest first. Name the flag or variable in the heading when there is one, and link the PR.

Give the before and after for anything an operator has configured, and a **Migration** line whenever the change needs action. A change that needs none says so.

```markdown
### `FOO_TIMEOUT_MS` replaces `FOO_TIMEOUT` ([#123](https://github.com/aztec-labs-eng/aztec-node/pull/123))

The timeout is now read in milliseconds, and the old name is no longer read at all: a node still
setting it starts with the default of 30s rather than the value it was given.

**Migration**: rename the variable and multiply the value by 1000.
```

## Unreleased

_No entries yet._
