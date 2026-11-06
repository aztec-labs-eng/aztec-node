# Developer changelog

Changes that contract, app and wallet developers have to act on, or will notice, in Aztec.nr, the PXE, Aztec.js and the CLI: public APIs and types, the behaviour of the PXE and its hooks, and the `aztec` and `aztec-wallet` commands developers run. Internal refactors, tests and CI do not belong here, and neither does anything only node operators see: that goes in the [operator changelog](./CHANGELOG-OPERATORS.md).

Each release line keeps its own copy of this file on its own branch. This one is `v6`, which ships the 6.x line; the v7 line's copy is on the `main` branch. An entry belongs on every branch whose releases carry the change, which for a backport means both.

At a stable release, the `## Unreleased` section becomes that version's section, and the developer part of the GitHub release notes is written from it. Write each entry for the developer who will read those notes, not for the reviewer of the PR.

## Format

Every version has one `###` section per component, each split into `#### New features`, `#### Breaking changes`, `#### Deprecations` and `#### Fixes`. `## Unreleased` keeps all of them, empty or not; a released version keeps only those with entries.

An entry goes under the component whose users have to act on it or will notice it: Aztec.nr for contract developers, including Noir tests written with `TestEnvironment`; PXE for wallet developers, including the PXE's hooks and its browser stores; Aztec.js for app developers, including `@aztec-labs/wallets` and `@aztec-labs/wallet-sdk`; CLI for the `aztec` and `aztec-wallet` commands. A change that asks something different of the users of two components gets an entry under each, each saying what those users see.

Each entry is one bullet, newest first: a bold sentence saying what changed, a link to the PR, then what a developer sees and has to do.

A change to any of the following is breaking, and its entry says how to migrate:

- **aztec-nr API**: `pub` modules, functions, and anything else that would stop a developer's contracts and tests from compiling against the new version without source changes.
- **PXE API**: functions, parameters, and anything that might break the build of a wallet with no source changes. PXE itself depends on many packages which are published but are _not_ meant to be used directly by external developers, e.g. `simulator`. A good rule of thumb is whether there are currently any external dependents on the API in question.
- **CLI**: mostly the `aztec` CLI, e.g. commands or flags being renamed, behavioral changes, and anything that might break or cause undesired behavior in a script that invokes the CLI.
- **Wallet and aztec.js**: changes that affect application developers, such as those in the wallet interface, in common aztec.js functions and types, etc.

Note that changes to _internal_ interfaces, e.g. the aztec-nr <> PXE oracle interface, or the PXE's store layouts, are not considered breaking changes from the perspective of an external user. Deprecating something that keeps working is not breaking either: its entry goes under Deprecations and names the replacement. A breaking entry includes a diff when code has to change.

````markdown
- **`foo` is renamed `bar`** ([#123](https://github.com/aztec-labs-eng/aztec-node/pull/123)). The old name is
  removed, so code still calling it no longer compiles.

  ```diff
  - foo(x);
  + bar(x);
  ```
````

## Unreleased

### Aztec.nr

#### New features

- **`get_tx_effects_with_block` returns each settled transaction's effects with the block that included it** ([#550](https://github.com/aztec-labs-eng/aztec-node/pull/550)). A contract that calls it needs a PXE on oracle interface 33.1 or later.
- **`NoteValidationRequest` is public** ([#535](https://github.com/aztec-labs-eng/aztec-node/pull/535)), exported from `aztec::messages::processing` with `owner()`, `storage_slot()`, `packed_note()` and `tx_hash()` accessors.

#### Breaking changes

- **In Noir tests, unconstrained messages between `TestEnvironment` accounts follow the PXE's new default tagging** ([#608](https://github.com/aztec-labs-eng/aztec-node/pull/608)). A message from one account to another now establishes a non-interactive handshake instead of using an address-derived secret, unless a strategy is set with `with_default_tag_secret_strategy`. A strategy set that way now also applies to a send from an account to itself.

#### Deprecations

- **`get_app_address_derived_tagging_secret` replaces `get_app_tagging_secret`, and `compute_app_siloed_shared_secret_from_point` replaces `compute_app_siloed_shared_secret`** ([#620](https://github.com/aztec-labs-eng/aztec-node/pull/620), [#621](https://github.com/aztec-labs-eng/aztec-node/pull/621)). The old names still work and are deprecated.

#### Fixes

### PXE

#### New features

- **`getPrivateEvents` returns each event's commitment randomness**, in `PackedPrivateEvent.randomness` ([#618](https://github.com/aztec-labs-eng/aztec-node/pull/618)). Together with the event's selector and packed content it is the preimage of the event's commitment, so a user can disclose a single private event: anyone can recompute the commitment, silo it with the contract address and find it in the nullifier tree. `BaseWallet.getPrivateEvents` is unchanged, so apps behind a wallet do not receive it.
- **The `resolveExpirationAndPadding` hook lets a wallet choose a transaction's expiration timestamp and side-effect padding** ([#601](https://github.com/aztec-labs-eng/aztec-node/pull/601)). The PXE calls it before the final reset and tail kernels, and in kernelless simulation, with the anchor block's timestamp, the latest expiration the kernels allow, and how many side effects of each kind the transaction creates. The hook returns the expiration timestamp to publish and the length to pad each side-effect array to. The PXE fills the padding with random values shaped like real side effects, and rejects answers the kernels cannot publish. Simulation pads the same way, so its gas estimate includes the padding. `roundDownTxExpirationTimestamp` is exported so a hook can keep the default expiration. Without the hook, proving behaves as before.

#### Breaking changes

- **The `resolveTaggingSecretStrategy` hook also decides self-sends** ([#608](https://github.com/aztec-labs-eng/aztec-node/pull/608)). The PXE used to replace the hook's answer with an address-derived secret for unconstrained delivery to one of the wallet's own accounts. It now applies the hook's answer to every message without a registered handshake. `DEFAULT_TAGGING_SECRET_STRATEGY` is replaced by `defaultTaggingSecretStrategy`, which returns the strategy the PXE applies when no hook is configured. To keep an address-derived secret for a send from an account to itself, return `defaultTaggingSecretStrategy` for the messages your hook has no policy for:

  ```diff
   resolveTaggingSecretStrategy: async (request) =>
     knownContacts.has(request.recipient.toString())
       ? { type: 'address-derived' }
  -    : { type: 'non-interactive-handshake' },
  +    : defaultTaggingSecretStrategy(request),
  ```

- **`generateSimulatedProvingResult` takes the transaction's max expiration timestamp and an options object** ([#600](https://github.com/aztec-labs-eng/aztec-node/pull/600), [#601](https://github.com/aztec-labs-eng/aztec-node/pull/601)). Its fourth argument, in `@aztec-labs/pxe/simulator`, is the latest expiration timestamp the transaction may publish. For a transaction that may be sent, compute it with `computeSimulatedMaxExpirationTimestamp`, so the simulated expiration matches the proven one. The optional settings follow in an options object, which also accepts the wallet's `resolveExpirationAndPadding` hook.

  ```diff
  - await generateSimulatedProvingResult(result, getFunctionName, node, minRevertibleSideEffectCounter);
  + await generateSimulatedProvingResult(
  +   result,
  +   getFunctionName,
  +   node,
  +   await computeSimulatedMaxExpirationTimestamp(result, node),
  +   { minRevertibleSideEffectCounterOverride: minRevertibleSideEffectCounter },
  + );
  ```

#### Deprecations

- **`computeAppSiloedSharedSecretFromPoint` replaces `appSiloEcdhSharedSecretPoint`** in `@aztec-labs/stdlib/logs` ([#620](https://github.com/aztec-labs-eng/aztec-node/pull/620)). The old name still works and is deprecated.

#### Fixes

- **Errors in PXE logs keep their message and stack** ([#599](https://github.com/aztec-labs-eng/aztec-node/pull/599)). They were logged as `{}`.
- **Kernelless simulation reports the expiration timestamp the proven transaction publishes** ([#600](https://github.com/aztec-labs-eng/aztec-node/pull/600)). It skipped the cap at each called contract's class id update horizon and the PXE's rounding, so a simulated transaction could expire an hour later than the same transaction once proven.
- **A browser PXE store survives a reload during a commit** ([#578](https://github.com/aztec-labs-eng/aztec-node/pull/578)). A worker killed mid-commit left a journal SQLite never rolled back, and the next open failed with `SQLITE_CORRUPT`. The bundled sqlite3mc is now 2.6.1, on SQLite 3.54.0.
- **A browser PXE store survives a page navigation during its first open** ([#551](https://github.com/aztec-labs-eng/aztec-node/pull/551)). Such an open left the store's file pool short, and every later open failed with `SQLITE_CANTOPEN` until the site's data was cleared.

### Aztec.js

#### New features

#### Breaking changes

- **The packages require Node.js 24** ([#674](https://github.com/aztec-labs-eng/aztec-node/pull/674)). Every package's `engines.node` is now `>=24`, up from `>=20.16`.
- **An app on this version cannot parse `simulateTx` results that carry tagged logs from a wallet on an earlier version** ([#620](https://github.com/aztec-labs-eng/aztec-node/pull/620)). The `AppTaggingSecret` in those results now requires a `deliveryMode` field, which earlier versions write as `kind`.
- **`L1RollupConstants` no longer has `rollupManaLimit`** ([#546](https://github.com/aztec-labs-eng/aztec-node/pull/546)). Governance can raise the limit on L1 at any time, so read it with `RollupContract.getManaLimit()`. The node's `getL1Constants` still returns the field, filled with the live value, but it is deprecated and no longer part of the response type.

#### Deprecations

#### Fixes

- **An ephemeral browser `EmbeddedWallet` keeps its PXE data in memory** ([#571](https://github.com/aztec-labs-eng/aztec-node/pull/571)). `EmbeddedWallet.create(node, { ephemeral: true })` persisted its PXE store in the browser, so a second ephemeral wallet on the same page failed with `SQLite-OPFS pool ... is already in use by another store instance`.

### CLI

#### New features

#### Breaking changes

#### Deprecations

#### Fixes

- **`aztec test` no longer crashes on a slow reader or hangs when the TXE dies** ([#592](https://github.com/aztec-labs-eng/aztec-node/pull/592)). When its output went to a pipe that filled up, nargo exited with code 101. It now also fails up front when port 8081 is taken, and reports the TXE's exit status if the TXE dies before it starts listening.
