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

Each release includes a `packages.tar.gz` containing a standalone `package.json` and
`package-lock.json`. The installer extracts them into the version directory and runs `npm ci`.
This fixes the complete npm dependency tree for that release, including transitive packages.
A later publication within a dependency range cannot change an existing release's install.

### Build

The aztec-up build fake-publishes the public Yarn workspaces at version `0.0.1` to a local
Verdaccio registry. Its npmjs proxy supplies third-party packages and the foundation pins.
`yarn-project/scripts/generate-aztec-up-package-lock.mjs` resolves the two installer packages
(`@aztec-labs/aztec` and `@aztec-labs/cli-wallet`) and their dependencies. It uses
`yarn-project/yarn.lock` as an npm resolution hint, adds required peers, rejects package
versions absent from that Yarn lock, and checks the result with `npm ci` and `npm ls`.

The build archive contains the manifest, npm lock, and a hash of the dependency inputs.
It is embedded in the aztec-up test image. The cached registry seed and lock use the same
dependency-input key; the seed supplies tarballs for the image's offline installer tests.
On an image-cache hit, the build extracts the lock from that image.

### Release

`bootstrap.sh ci-release` builds before publishing. Before any project publishes, its release
preflight turns the checked build lock into the target version using
`yarn-project/scripts/aztec-up-release-lock.mjs`. It rejects an archive whose input hash
does not match the current Yarn lock, generator, root resolutions, workspace dependency
fields, and package rewrite rules. The transform changes the root version, each co-published `@aztec-labs/*` version
and tarball URL, and references to those packages in their dependency fields. It leaves
third-party versions, URLs, and integrity values unchanged. It performs no npm resolution,
registry fetch, or package installation.

The aztec-up release then uploads the transformed two-file archive to
`install.aztec.network/<version>/packages.tar.gz` before updating installer aliases.
Only the co-published packages lack integrity values: their public tarballs do not exist
when the build lock is made, and npm package versions cannot be overwritten. Every
other locked tarball retains its integrity check.

### Install

The installer downloads the release archive and runs `npm ci`. npm selects native optional
packages for the user's platform. The npm lock does not cover Node, Noir, Foundry, or
downloads performed by package installation scripts.

To skip the release lock, explicitly select the original npm installation path:

```sh
AZTEC_UP_SKIP_PACKAGE_LOCK=1 aztec-up install <version>
```

This also skips downloading the lock artifact. npm then resolves dependencies using its normal
configuration, so versions can differ from those approved for the release. A failed locked install
does not automatically enable the opt-out.
