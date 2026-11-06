# Advisory public API report

This source inventory compares the environment, the TypeScript `aztec` entrypoint, and registered public/admin Node RPC
interfaces. It does not build packages, import application modules, start a node, enforce semver, or require changelog entries.
The only dependency is TypeScript, already present in `yarn-project`.

From the repository root:

```sh
node yarn-project/scripts/public-api/report.mjs --base origin/main --head HEAD --output /tmp/public-api-report
node yarn-project/scripts/public-api/report.mjs --base origin/main --head worktree --output /tmp/public-api-report
```

The base is resolved with `git merge-base`. `worktree` includes tracked edits and untracked source files, and uses `HEAD` to
find that merge-base. `--root` selects another repository; `--config` selects a surface configuration. The JSON artifact
contains both inventories, source locations, and complete changes; Markdown provides the review summary. Keys are API names:
renames appear as removal plus addition. Descriptions, comments, declaration order, and formatting are ignored.

Exit codes are distinct:

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| 0    | Complete inventory, no detected API changes                                   |
| 1    | Complete inventory, API additions, removals, or modifications                 |
| 2    | Parser/operational failure or incomplete extraction; never a clean API result |

## CI behavior and cost

`.github/workflows/public-api-report.yml` runs independently of CI3. Its job has `continue-on-error: true`: the report step
can fail while the workflow remains advisory. It is not added to CI3's test/lint aggregates or required commit statuses.
Keep this new advisory check out of branch-protection required checks; making it required would change that policy.

CI checks out GitHub's proposed merge result with depth 2, then compares `HEAD^1` (the target-branch parent) with `HEAD`
(the merged candidate). This includes the PR's changes as they would apply to its target without fetching the repository's
full history. Locally, explicit refs compare their merge-base with the selected candidate. PRs with merge conflicts do not
have a runnable GitHub merge ref and must resolve their conflicts first.

The workflow installs only the exact TypeScript version resolved in `yarn.lock`, with lifecycle scripts disabled, in the
runner's temporary directory. It uses read-only repository permission, no secrets, and no write credentials. Both summaries
and artifacts survive a detected API difference; checkout/setup/analysis errors are reported separately.

A same-revision comparison on the initial main snapshot reads Git objects in batches and parses about 290 source files:
roughly 5–7 seconds and 360 MB peak RSS locally, with 424 environment, 663 CLI, and 142 RPC entries. Runtime varies with source
size and runner hardware. No submodules or monorepo installation are needed.

## Coverage and extension

`surfaces.json` is the scope configuration.

- **Environment:** the canonical `EnvVar` union, production `env` declarations with configuration metadata, and Commander
  `.env()` options. Metadata includes defaults, boolean/type/schema declarations, parsers, fallback aliases, and deprecated
  alias transforms. This inventories declarations, not a proof that each declaration is used. An obsolete name remaining in
  `EnvVar` remains a declared name. Arbitrary `process.env` reads, shell scripts, and CI-only variables are outside this scope.
- **CLI:** commands reachable through the TypeScript `aztec` entrypoint, including injected CLI/builder commands, nested
  commands, aliases, positional argument shapes, required flags, option aliases, declarative defaults, parsers, environment
  aliases, and generated `start` options. Commander `Option` factories, literal spreads, imported constants, and config
  selection helpers are supported. Defaults introduced only inside action handlers and the shell wrapper's commands are
  outside this inventory.
- **RPC:** registered `aztec`, `aztecAdmin`, and `p2p` schemas, plus legacy aliases such as `node` and `nodeAdmin`. Debug-only
  namespaces are excluded. Method records include their endpoint, Zod schema expressions, and declared parameter/return
  types. Imported schema constants, static schema getters, schema helper bodies, and referenced type aliases/interfaces are
  followed from these roots. This is not an inventory of all exported TypeScript declarations.

The resolver follows workspace `package.json` exports from `dest` to `src`, without resolving through installed workspace
symlinks. Function parameters/local bindings and source aliases are normalized; parser/transform bodies are represented by
SHA-256 digests of normalized syntax. Schema expressions and runtime-dependent defaults remain symbolic source expressions,
not evaluated values. Changing a parser's implementation can therefore warrant review even when its behavior is equivalent.
External package implementations, complex mapped types, arbitrary mutation/control flow, and runtime-generated APIs are not
fully evaluated. Unsupported registration/option/object patterns produce explicit incomplete-analysis diagnostics. Missing
sources, malformed syntax, and unsupported adapter implementations produce analysis failures.

The generated `start` flags need three small adapters for `getOptions`, `configToFlag`, and `addOptions`. Their supported
implementation fingerprints are in the configuration. These fingerprints use normalized AST behavior, include relevant helper
implementations, and exclude changing option data. A generator/helper behavior change fails analysis until its extraction
adapter is reviewed and updated; merely accepting the reported fingerprint can hide API changes. Multiple fingerprints can
be retained when an adapter explicitly supports both old and new implementations during a PR comparison.

New surfaces should add explicit roots/adapters here. Avoid broadening this into an all-repository exported-symbol diff.
