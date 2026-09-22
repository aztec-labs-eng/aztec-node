# The Aztec Installation Script

```
bash -i <(curl -s https://install.aztec.network)
```

That is all.

This will install into `~/.aztec/bin` a collection of scripts to help with running aztec containers, and will update
the user's `PATH` variable in their shell startup script so they can be found.

- `aztec` - compiles and tests contracts, launches infrastructure subsystems, interacts with the network.
- `aztec-up` - a version manager for the Aztec toolchain.
- `aztec-wallet` - a tool for interacting with the Aztec network.
- `aztec-bb` - the Barretenberg proving backend.
- `aztec-nargo` - the Noir compiler and simulator.
- `aztec-forge`, `aztec-cast`, `aztec-anvil`, `aztec-chisel` - the bundled Foundry tools.

Foundry, Noir, and Barretenberg are bundled at the versions `aztec` needs. Your own `forge` / `nargo` / `bb` installs still work under their bare names.

After installed, you can use `aztec-up` to install specific versions.

```
aztec-up install nightly
```

This will install the nightly build.

```
aztec-up install 1.2.3
```

This will install the tagged release version 1.2.3.

## Testing

```
INSTALL_URI=file://$(git rev-parse --show-toplevel)/aztec-up/bin $(git rev-parse --show-toplevel)/aztec-up/bin/aztec-install
```

## Locked npm dependencies

Each release includes `packages.tar.gz`, containing a standalone package manifest, Yarn lockfile,
Yarn configuration, patches, and the exact Yarn CLI version declared by `yarn-project/package.json`.
The installer downloads this artifact and runs an immutable installation. It does not require a
user-installed Yarn and does not fall back to an unlocked npm install.

`scripts/generate-package-lock.mjs` seeds the release lock from `yarn-project/yarn.lock`, retaining
external dependency selections, checksums, and root resolutions. Workspace entries are replaced
by metadata from the published release packages. Yarn package extensions supply non-optional
peers that npm previously installed automatically, using versions from the approved lock.
Generation fails if an external resolution or existing checksum differs from that lock. Update the monorepo dependencies intentionally
before releasing a newly required external dependency.

The build generates an artifact for the fake `0.0.1` packages and fetches its dependencies into
Verdaccio before creating the offline test image. Release generation runs after the real npm
packages are published; the binary archive is uploaded separately from the version-stamped scripts.
The artifact contains no installed dependencies, so native packages are selected on the user's
platform. Node, Noir, Foundry, and downloads performed by package lifecycle scripts remain outside
this lock.

Run the package-resolution regression test after installing the monorepo dependencies:

```sh
node --test aztec-up/test/package_lock.test.mjs
```

It uses a local registry fixture and downloads the pinned Yarn CLI. It checks that newer upstream
publications cannot change the installed dependency and that unapproved resolutions, inconsistent
manifests, and missing artifacts fail.
