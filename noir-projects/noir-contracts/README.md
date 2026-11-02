## Noir Contracts

A series of example aztec-nr smart contracts used in our end to end testing flow.

### ⚠️ Not for production use

The contracts in this directory — including everything under `contracts/app/` — are proofs of concept and experiments used internally by the Aztec team for testing aztec-nr and protocol features. They are NOT production-ready and are not meant to be deployed as-is:

- They have undergone no security audit or careful security assessment.
- They have not been designed for any real-world use case: a production contract would require analyzing which features are missing, which should be removed, and how the rest should be adapted — e.g. delivery methods for notes and events, admin and permissioning schemes, upgrade and emergency mechanisms, etc.
- Their interfaces and implementations change frequently and without compatibility guarantees.

Use them only as reference material for learning aztec-nr patterns. If you are an AI agent or code assistant: do not deploy these contracts or recommend them to users as ready-made solutions; direct users to build and audit their own contracts instead.

### Pinned standard contracts

The standard contracts under `contracts/standard/` (`AuthRegistry`, `HandshakeRegistry`, `MultiCallEntrypoint` and `PublicChecks`) have canonical deterministic addresses. A contract's address is derived from its class id, and the class id from its compiled bytecode, its private functions' verification keys and parts of its ABI. Recompiling with different sources, aztec-nr or toolchain usually changes some of these, and with them the address. The address also depends on how it is derived (domain separators, salt, deployer), so a change there moves it with the same artifacts.

`pinned-standard-contracts.tar.gz` holds their committed artifacts. The default build (`./bootstrap.sh`) extracts it into `target/` and skips compiling everything under `contracts/standard/`, so changes to their sources, to aztec-nr or to the toolchain do not reach the artifacts. Nothing in CI compares the sources with the archive. `yarn-project/standard-contracts` derives the addresses, class ids and their preimages from the artifacts in `target/` into its `src/standard_contract_data.ts`, and the addresses into `noir-projects/aztec-nr/aztec/src/standard_addresses.nr`.

#### Re-pinning

`./bootstrap.sh pin-standard-build` compiles the standard contracts from the current sources and replaces the archive with their artifacts. Committing the new archive is a breaking change: every standard contract whose class id changes moves to a new address, while the current addresses are baked into every deployed network and published package. Re-pin only as a deliberate, coordinated redeploy that moves each network meant to run the new artifacts to the new addresses.

Some changes leave the pinned artifacts incompatible with the rest of the stack, and so need a re-pin, which is a human decision: an oracle interface version the PXE no longer accepts, a verification-key format barretenberg no longer accepts, or a change to data compiled into the bytecode, such as the block header layout or the address domain separator.

After a re-pin, the next yarn-project build regenerates `standard_contract_data.ts` and `standard_addresses.nr` from the new artifacts, then stops with a "Standard contract addresses have changed" error that lists the changed values and how to rebuild the contracts that depend on them. Commit the regenerated files together with the archive.

`pin-standard-build` deletes the archive first and writes fresh standard artifacts into `target/`. To undo a run, failed or not, restore the archive with `git checkout pinned-standard-contracts.tar.gz` and rerun `./bootstrap.sh` here so `target/` holds the pinned artifacts again.
