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

Each release ships a `packages.tar.gz` holding a standalone `package.json` and `package-lock.json`.
The installer extracts both into the version directory and runs `npm ci`. The lock pins the whole
npm dependency tree of that release, transitive packages included, so a package published later
within some dependency range cannot change what an existing release installs.

The lock covers npm packages only. Node, Noir, Foundry, and anything a package's install script
downloads are outside it.

### Build

The aztec-up build fake-publishes the public Yarn workspaces at version `0.0.1` to a local Verdaccio
registry. Verdaccio proxies npmjs for third-party packages and the foundation pins.

`yarn-project/scripts/generate-aztec-up-package-lock.mjs` then resolves the two installer packages,
`@aztec-labs/aztec` and `@aztec-labs/cli-wallet`, against that registry. It:

- uses `yarn-project/yarn.lock` as the npm resolution hint,
- adds the peer dependencies npm would otherwise leave out,
- rejects any package version that the Yarn lock does not contain,
- checks the result with `npm ci` and `npm ls`.

The resulting archive holds the manifest, the npm lock, and a hash of the inputs that decide the
lock: the Yarn lock, the root resolutions, the generator, the package rewrite rules, and the
workspace manifest fields that npm copies into a lock entry (dependencies, `bin`, `engines`,
`os`/`cpu`, install scripts, ...). It is copied into the aztec-up test image, whose cache key
includes the same hash, and on an image-cache hit the build reads it back out of that image. The
cached Verdaccio seed and the cached lock share the same input hash, so a reused lock always comes
with a seed that holds its tarballs. The test image's registry is offline and installs from that
seed.

### Release

`bootstrap.sh ci-release` builds before it publishes. Before any project publishes, the aztec-up
release preflight runs `yarn-project/scripts/aztec-up-release-lock.mjs` on the build archive. The
script:

- rejects an archive whose input hash differs from the current one, so a lock built before any of
  those inputs changed is never released,
- sets the release version on the root, on every co-published `@aztec-labs/*` package, on their
  tarball URLs, and on references to those packages in dependency fields,
- leaves third-party versions, URLs, and integrity values untouched,
- performs no npm resolution, registry fetch, or package installation.

The aztec-up release then uploads the two-file archive to
`install.aztec.network/<version>/packages.tar.gz` before it moves the installer aliases.

Only the co-published packages carry no integrity value: their public tarballs do not exist when
the build lock is made, and npm never lets a published version change. Every other tarball in the
lock keeps its integrity check.

### Install

The installer downloads the release archive and runs `npm ci`. npm picks the native optional
packages for the user's platform.

To install without the lock, select the plain npm path explicitly:

```sh
AZTEC_UP_SKIP_PACKAGE_LOCK=1 aztec-up install <version>
```

This skips the archive download. npm resolves dependencies with its normal configuration, so the
installed versions can differ from the ones approved for the release. A failed locked install does
not switch to this path on its own.
