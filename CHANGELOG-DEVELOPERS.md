# Developer changelog

Changes that contract, app and wallet developers have to act on, or will notice, in Aztec.nr, the PXE, Aztec.js and the CLI: public APIs and types, the behaviour of the PXE and its hooks, and the `aztec` and `aztec-wallet` commands developers run. Internal refactors, tests and CI do not belong here, and neither does anything only node operators see: that goes in the [operator changelog](./CHANGELOG-OPERATORS.md).

Each release line keeps its own copy of this file on its own branch. This one is `main`, which ships as v7; the 6.x line's copy is on the `v6` branch. An entry belongs on every branch whose releases carry the change, which for a backport means both.

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

- **`MessagingSecretStrategy::recipient_tsk()` selects the `recipient-tsk` strategy in Noir tests** ([#642](https://github.com/aztec-labs-eng/aztec-node/pull/642)), set with `with_default_messaging_secret_strategy`. It is also the default strategy PXE uses if the recipient keys are in scope, so unconstrained sends to any `TestEnvironment` account, self-sends included, also use it.
- **`get_tx_effects_with_block` returns each settled transaction's effects with the block that included it** ([#550](https://github.com/aztec-labs-eng/aztec-node/pull/550)). A contract that calls it needs a PXE on oracle interface 33.1 or later.
- **`NoteValidationRequest` is public** ([#535](https://github.com/aztec-labs-eng/aztec-node/pull/535)), exported from `aztec::messages::processing` with `owner()`, `storage_slot()`, `packed_note()` and `tx_hash()` accessors.

#### Breaking changes

- **`compute_secret_hash` is renamed `compute_private_content_hash`, and it returns a different hash** ([#689](https://github.com/aztec-labs-eng/aztec-node/pull/689)). The two application fields of an L1-to-L2 message are renamed for what they are: `content` is the message's public content hash, and its secret hash is its private content hash. The preimage a contract reveals to consume the message is its private content, which the application defines: a single claim secret, as in the fee juice and token bridges, or something richer. The hash now uses the `DOM_SEP__PRIVATE_CONTENT_HASH` domain separator, so a contract built with this version cannot consume a message whose hash was computed the old way: claim pending messages before upgrading, or send them again afterwards. `consume_l1_to_l2_message`, `compute_l1_to_l2_message_hash` and `compute_l1_to_l2_message_nullifier` keep their arguments in the same order, under the new names.

  ```diff
  - use aztec::hash::compute_secret_hash;
  - let secret_hash = compute_secret_hash([secret]);
  + use aztec::hash::compute_private_content_hash;
  + let private_content_hash = compute_private_content_hash([secret]);
  ```

- **`TestEnvironment::send_l1_to_l2_message` takes the message's private content as an array** ([#689](https://github.com/aztec-labs-eng/aztec-node/pull/689)), the same array the contract passes to `consume_l1_to_l2_message`. `send_l1_to_l2_message_from_secret_hash` is renamed `send_l1_to_l2_message_from_private_content_hash`.

  ```diff
  - env.send_l1_to_l2_message(content, secret, sender, recipient);
  + env.send_l1_to_l2_message(public_content_hash, [secret], sender, recipient);
  ```

- **The `MessageEncryption` trait and the `AES128` type are removed** ([#662](https://github.com/aztec-labs-eng/aztec-node/pull/662)). Their operations are free functions in `aztec::messages::encryption::aes128`, so code that imports the trait no longer compiles.

  ```diff
  - use aztec::messages::encryption::{aes128::AES128, message_encryption::MessageEncryption};
  + use aztec::messages::encryption::aes128;

  - let ciphertext = AES128::encrypt(plaintext, recipient, contract_address);
  + let ciphertext = aes128::encrypt_with_ecdh_secret(plaintext, recipient, contract_address);

  - let plaintext = AES128::decrypt(ciphertext, recipient, contract_address);
  + let plaintext = aes128::decrypt_with_ecdh_secret(ciphertext, recipient, contract_address);
  ```

- **Onchain messages are encrypted with the messaging secret that tags them** ([#651](https://github.com/aztec-labs-eng/aztec-node/pull/651)), instead of with a Diffie-Hellman exchange against the recipient's address keys. Offchain messages still use the address keys, and messages sent by earlier versions still decrypt. Contracts compiled with this version need a PXE on oracle interface 33.4 or later. `process_message_ciphertext` takes the message's messaging secret after the ciphertext: for a message found by a tag, pass the secret that produced the tag; `Option::none()` decrypts with the recipient's address keys only, which is right for offchain messages but misses onchain messages sent by this version. `EPH_PK_X_SIZE_IN_FIELDS` is renamed `SALT_OR_EPH_PK_X_SIZE_IN_FIELDS`.

  ```diff
   process_message_ciphertext(
       contract_address,
       compute_note_hash,
       compute_note_nullifier,
       process_custom_message,
       message_ciphertext,
  +    Option::some(messaging_secret),
       resolved_tx,
       recipient,
   );
  ```

- **In Noir tests, unconstrained messages between `TestEnvironment` accounts follow the PXE's default messaging secret strategy** ([#608](https://github.com/aztec-labs-eng/aztec-node/pull/608)) instead of using an address-derived secret, unless a strategy is set with `with_default_messaging_secret_strategy`. A strategy set that way now also applies to a send from an account to itself.

#### Deprecations

- **Tagging secrets are renamed messaging secrets** ([#646](https://github.com/aztec-labs-eng/aztec-node/pull/646)). The old names still work and are deprecated. In `aztec::oracle::notes`, `get_address_derived_messaging_secret` replaces `get_app_address_derived_tagging_secret` and `get_app_tagging_secret`. In `aztec::messages::delivery`, `ResolvedMessagingSecretStrategy` replaces `ResolvedTaggingStrategy`. On `TestEnvironmentOptions`, `with_default_messaging_secret_strategy` and `with_default_messaging_secret_strategy_all_modes` replace `with_default_tag_secret_strategy` and `with_default_tag_secret_strategy_all_modes`. The `test::helpers::messaging_secret_strategy` module and its `MessagingSecretStrategy` replace `test::helpers::tagging_secret_strategy` and its `TaggingSecretStrategy`. Noir warns on the old function names only, not on the old type and module names.
- **`get_app_address_derived_tagging_secret` replaces `get_app_tagging_secret`, and `compute_app_siloed_shared_secret_from_point` replaces `compute_app_siloed_shared_secret`** ([#620](https://github.com/aztec-labs-eng/aztec-node/pull/620), [#621](https://github.com/aztec-labs-eng/aztec-node/pull/621)). The old names still work and are deprecated.

#### Fixes

### PXE

#### New features

- **The `recipient-tsk` messaging secret strategy derives a message's secret from the recipient's tagging secret key** ([#642](https://github.com/aztec-labs-eng/aztec-node/pull/642)). Unlike with an address-derived secret, an attacker who breaks the recipient's address key, for example with a quantum computer, cannot compute its tags. It can only be used for unconstrained delivery to a recipient whose keys the PXE holds and who is in the execution's scopes, which `MessagingSecretStrategyRequest.recipientTskAvailable` reports. The send fails otherwise.
- **`getPrivateEvents` returns each event's commitment randomness**, in `PackedPrivateEvent.randomness` ([#618](https://github.com/aztec-labs-eng/aztec-node/pull/618)). Together with the event's selector and packed content it is the preimage of the event's commitment, so a user can disclose a single private event: anyone can recompute the commitment, silo it with the contract address and find it in the nullifier tree. `BaseWallet.getPrivateEvents` is unchanged, so apps behind a wallet do not receive it.
- **The `resolveExpirationAndPadding` hook lets a wallet choose a transaction's expiration timestamp and side-effect padding** ([#601](https://github.com/aztec-labs-eng/aztec-node/pull/601)). The PXE calls it before the final reset and tail kernels, and in kernelless simulation, with the anchor block's timestamp, the latest expiration the kernels allow, and how many side effects of each kind the transaction creates. The hook returns the expiration timestamp to publish and the length to pad each side-effect array to. The PXE fills the padding with random values shaped like real side effects, and rejects answers the kernels cannot publish. Simulation pads the same way, so its gas estimate includes the padding. `roundDownTxExpirationTimestamp` is exported so a hook can keep the default expiration. Without the hook, proving behaves as before.

#### Breaking changes

- **The `resolveTaggingSecretStrategy` hook is renamed `resolveMessagingSecretStrategy`** ([#646](https://github.com/aztec-labs-eng/aztec-node/pull/646)). The PXE no longer reads the old key. TypeScript rejects it in an object literal passed as `PXECreationOptions.hooks`, and in a hooks object that sets no other hook. A hooks object built elsewhere that also sets another hook still type-checks: the hook under the old key is ignored, and the PXE applies `defaultMessagingSecretStrategy` to every message instead.

  ```diff
   hooks: {
  -  resolveTaggingSecretStrategy: async (request) => policy(request),
  +  resolveMessagingSecretStrategy: async (request) => policy(request),
   },
  ```

- **Unconstrained sends to local accounts in scope default to the `recipient-tsk` strategy, self-sends included** ([#642](https://github.com/aztec-labs-eng/aztec-node/pull/642)). A local account is one whose keys the PXE holds. Self-sends used an address-derived secret, and sends to other local accounts a non-interactive handshake. A PXE on an earlier version does not find messages tagged this way. `MessagingSecretStrategyRequest` has a new required `recipientTskAvailable` field, which `defaultMessagingSecretStrategy` takes in place of `sender` and `recipient`. A hook that passes it the whole request needs no change, and code that builds its argument must pass `recipientTskAvailable`. An exhaustive switch over `MessagingSecretStrategy` must handle the new variant.

  ```diff
  - defaultMessagingSecretStrategy({ sender, recipient, deliveryMode });
  + defaultMessagingSecretStrategy({ deliveryMode, recipientTskAvailable });
  ```

- **The `resolveMessagingSecretStrategy` hook also decides self-sends** ([#608](https://github.com/aztec-labs-eng/aztec-node/pull/608)). The PXE used to replace the hook's answer with an address-derived secret for unconstrained delivery to one of the wallet's own accounts. It now applies the hook's answer to every message without a registered handshake. `DEFAULT_TAGGING_SECRET_STRATEGY` is replaced by `defaultMessagingSecretStrategy`, which returns the strategy the PXE applies when no hook is configured. To leave self-sends and the other messages your hook has no policy for to the PXE's default, return `defaultMessagingSecretStrategy` for them:

  ```diff
   resolveMessagingSecretStrategy: async (request) =>
     knownContacts.has(request.recipient.toString())
       ? { type: 'address-derived' }
  -    : { type: 'non-interactive-handshake' },
  +    : defaultMessagingSecretStrategy(request),
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

- **Tagging secrets are renamed messaging secrets** ([#646](https://github.com/aztec-labs-eng/aztec-node/pull/646)). The old names still work and are deprecated. On the PXE, `registerMessagingSecretSource`, `getMessagingSecretSources` and `removeMessagingSecretSource` replace `registerTaggingSecretSource`, `getTaggingSecretSources` and `removeTaggingSecretSource`, and the `MessagingSecretSource` and `RegisteredMessagingSecretSource` types replace `TaggingSecretSource` and `RegisteredTaggingSecretSource`. In `@aztec-labs/pxe/config`, `MessagingSecretStrategy`, `MessagingSecretStrategyRequest`, `ResolveMessagingSecretStrategy` and `defaultMessagingSecretStrategy` replace `TaggingSecretStrategy`, `TaggingSecretStrategyRequest`, `ResolveTaggingSecretStrategy` and `defaultTaggingSecretStrategy`. In `@aztec-labs/stdlib/logs`, `MessagingSecret`, `MessagingSecretSchema` and `messagingSecretFromString` replace `AppTaggingSecret`, `AppTaggingSecretSchema` and `appTaggingSecretFromString`, and `computeAddressDerivedSharedSecretPoint` replaces `computeSharedTaggingSecret`.
- **`computeAppSiloedSharedSecretFromPoint` replaces `appSiloEcdhSharedSecretPoint`** in `@aztec-labs/stdlib/logs` ([#620](https://github.com/aztec-labs-eng/aztec-node/pull/620)). The old name still works and is deprecated.

#### Fixes

- **Errors in PXE logs keep their message and stack** ([#599](https://github.com/aztec-labs-eng/aztec-node/pull/599)). They were logged as `{}`.
- **Kernelless simulation reports the expiration timestamp the proven transaction publishes** ([#600](https://github.com/aztec-labs-eng/aztec-node/pull/600)). It skipped the cap at each called contract's class id update horizon and the PXE's rounding, so a simulated transaction could expire an hour later than the same transaction once proven.
- **A browser PXE store survives a reload during a commit** ([#578](https://github.com/aztec-labs-eng/aztec-node/pull/578)). A worker killed mid-commit left a journal SQLite never rolled back, and the next open failed with `SQLITE_CORRUPT`. The bundled sqlite3mc is now 2.6.1, on SQLite 3.54.0.
- **A browser PXE store survives a page navigation during its first open** ([#551](https://github.com/aztec-labs-eng/aztec-node/pull/551)). Such an open left the store's file pool short, and every later open failed with `SQLITE_CANTOPEN` until the site's data was cleared.

### Aztec.js

#### New features

- **`getAllPublicEvents` returns every public event that matches a filter, oldest first** ([#624](https://github.com/aztec-labs-eng/aztec-node/pull/624)), from `@aztec-labs/aztec.js/events`. The filter is either a block range, whose `fromBlock` is required, or a `txHash`. Every page the read fetches comes from the fork of its `referenceBlock`, which defaults to the node's latest block when the read starts: the read throws if that block leaves the chain, and returns no events after it. One call can make many requests to the node and holds every event in memory, so split long ranges.

#### Breaking changes

- **`computePrivateContentHash` replaces `computeSecretHash`, takes an array, and returns a different hash** ([#689](https://github.com/aztec-labs-eng/aztec-node/pull/689)). It matches Aztec.nr's `compute_private_content_hash`, so a hash from the old helper no longer matches what contracts built with this version consume. `generateClaimSecret` is removed. `L1ToL2Message.content` and `L1ToL2Message.secretHash` are renamed `publicContentHash` and `privateContentHash`. `L2Claim.claimSecret` and `L2Claim.claimSecretHash` keep their names, and the hash is computed the new way. The L1 `Inbox` and `FeeJuicePortal` ABIs of this release rename the same fields, so code that reads `MessageSent` or `DepositToAztecPublic` logs by field name must read `publicContentHash` and `privateContentHash`.

  ```diff
  - const [secret, secretHash] = await generateClaimSecret();
  + const secret = Fr.random();
  + const secretHash = await computePrivateContentHash([secret]);
  ```

- **The packages require Node.js 24** ([#673](https://github.com/aztec-labs-eng/aztec-node/pull/673)). Every package's `engines.node` is now `>=24`, up from `>=20.16`.
- **An app on this version cannot parse `simulateTx` results that carry tagged logs from a wallet on an earlier version** ([#620](https://github.com/aztec-labs-eng/aztec-node/pull/620)). The `AppTaggingSecret` in those results now requires a `deliveryMode` field, which earlier versions write as `kind`.
- **`L1RollupConstants` no longer has `rollupManaLimit`** ([#546](https://github.com/aztec-labs-eng/aztec-node/pull/546)). Governance can raise the limit on L1 at any time, so read it with `RollupContract.getManaLimit()`. The node's `getL1Constants` still returns the field, filled with the live value, but it is deprecated and no longer part of the response type.

#### Deprecations

- **`getPublicEvents` is deprecated in favour of `getAllPublicEvents`** ([#624](https://github.com/aztec-labs-eng/aztec-node/pull/624)). It returns a single page of events, so a caller that reads only `events` misses the rest. `GetPublicEventsResult`, `PublicEventFilter`, `PublicEventFilterSchema` and `EventCursor` are deprecated with it. All of them keep working.

#### Fixes

- **An ephemeral browser `EmbeddedWallet` keeps its PXE data in memory** ([#571](https://github.com/aztec-labs-eng/aztec-node/pull/571)). `EmbeddedWallet.create(node, { ephemeral: true })` persisted its PXE store in the browser, so a second ephemeral wallet on the same page failed with `SQLite-OPFS pool ... is already in use by another store instance`.

### CLI

#### New features

#### Breaking changes

- **`aztec get-l1-to-l2-message-witness` takes `--private-content` in place of `--secret`** ([#689](https://github.com/aztec-labs-eng/aztec-node/pull/689)). The flag takes one or more fields, the message's private content. For a fee juice or token bridge claim, that is the claim secret. A script that still passes `--secret` fails.

#### Deprecations

#### Fixes

- **`aztec test` no longer crashes on a slow reader or hangs when the TXE dies** ([#592](https://github.com/aztec-labs-eng/aztec-node/pull/592)). When its output went to a pipe that filled up, nargo exited with code 101. It now also fails up front when port 8081 is taken, and reports the TXE's exit status if the TXE dies before it starts listening.
