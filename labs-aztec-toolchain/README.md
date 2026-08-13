Owns where the binaries labs components build with come from, so those components work the same in the monorepo and in a split labs repo.

`bootstrap.sh` pins a bb and a noir version and provisions `bin/`: `bb` via bbup, `nargo`/`noir-profiler` via noirup, `bb-avm` from its own release artifact (amd64 linux only), and `acvm` compiled from the noir release source, since nothing publishes it. `bin/.pin` records what was installed and is what makes a re-run incremental.

The pinned versions are also copied into manifests that cannot read them from here (e.g. `Nargo.toml`): `pins.mjs` lists those files. `./bootstrap.sh set-pins <bb-version> [noir-version]` bumps this file and every copy, and every pinned-mode build fails on drift. `./bootstrap.sh use-local <foundation-root>` instead points each copy that has a local form at a foundation checkout, and records the root in `.fnd-root` so builds provision `bin/` from the same checkout - the foundation repo applies it to its labs submodule's worktree after each submodule update and never commits the result.

Consumers take `NARGO`/`BB` from `bin/`, the toolchain identity from `bootstrap.sh hash` (for cache keys), and the pinned noir version from `bootstrap.sh noir_version`.
