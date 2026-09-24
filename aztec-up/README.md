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

Each release includes `packages.tar.gz` with a standalone `package.json` and `package-lock.json`.
The installer downloads the archive and runs `npm ci`. The lock records every installed package
version and tarball integrity, including transitive dependencies. A later publication within a
dependency range cannot change the installed tree for an existing release.

To skip the release lock, explicitly select the original npm installation path:

```sh
AZTEC_UP_SKIP_PACKAGE_LOCK=1 aztec-up install <version>
```

This also skips downloading the lock artifact. npm then resolves dependencies using its normal
configuration, so versions can differ from those approved for the release. A failed locked install
does not automatically enable the opt-out.

`scripts/generate-package-lock.mjs` uses the monorepo `yarn-project/yarn.lock` as the approved
version list. It prepares a temporary npm-readable resolution seed and the published Aztec
package versions, then generates an npm lock. Required peer dependencies are supplied at
approved versions. Generation rejects packages absent from the approved graph or missing
integrity data, and checks a clean `npm ci` before packaging the lock. The temporary seed is
not distributed.

The build generates an artifact for the fake `0.0.1` packages and fetches its dependencies into
Verdaccio before creating the offline test image. Release generation runs after the real npm
packages are published; the archive is uploaded separately from the version-stamped scripts.
Native optional packages are selected by npm for the user's platform. Node, Noir, Foundry, and
package lifecycle downloads remain outside the npm lock.
