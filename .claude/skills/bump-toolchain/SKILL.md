---
name: bump-toolchain
description: Bump the pinned bb/noir toolchain release (BB_VERSION/NOIR_VERSION in labs-aztec-toolchain) and every file that copies those pins. Use when asked to bump the toolchain, move to a newer nightly, or update the pinned bb/noir/aztec-packages release.
argument-hint: <bb-version | latest nightly>
---

# Bump the pinned toolchain release

`labs-aztec-toolchain/bootstrap.sh` pins `BB_VERSION` (an aztec-packages release: the bb
binaries and all `@aztec/*` npm packages) and `NOIR_VERSION` (the noir release that bb
release was built against). `labs-aztec-toolchain/pins.mjs` owns every file carrying a
copy of those pins; `set-pins` rewrites them all mechanically. This skill is the judgment
around that: pick a complete release, derive the paired noir version, run the rewrite,
refresh lockfiles, and prove the result builds.

## Steps

### 1. Resolve the target version

If given a version, strip any leading `v`. If asked for "latest nightly", list tags, not
GitHub releases — nightly tags have no release object on aztec-packages, and the releases
list interleaves older release lines. Filter to the currently pinned major; within one
release line the fixed-width date suffix makes lexicographic ref order chronological (with
two lines in the same major, `tail -1` picks the higher version, not the newer date —
confirm that is what you want):

```bash
current=$(sed -n 's/^BB_VERSION=//p' labs-aztec-toolchain/bootstrap.sh)
gh api --paginate "repos/AztecProtocol/aztec-packages/git/matching-refs/tags/v${current%%.*}." \
  --jq '.[].ref' | grep nightly | tail -1 | sed 's|refs/tags/v||'
```

A cross-major bump is a deliberate decision: only do it when the user names the version.

### 2. Verify the release is complete

Nightlies can partially publish: the tag can exist while an npm package or release
artifact is missing. Check all of the following before touching anything; on any miss,
fall back to the previous nightly rather than pinning a broken release.

- Every `@aztec-foundation/*` entry in `yarn-project/package.json`'s `resolutions` exists
  on npm at the target version:

  ```bash
  jq -r '.resolutions | keys[] | select(startswith("@aztec-foundation/"))' yarn-project/package.json \
    | xargs -I{} sh -c 'npm view {}@<version> version >/dev/null || echo "MISSING: {}"'
  ```

- The per-platform binary packages the toolchain curls exist at the target version:
  `@aztec-foundation/bb-{linux,darwin}-{x64,arm64}` and `@aztec-foundation/bb-avm-linux-{x64,arm64}`
  (bb-avm is published for linux only). Check the tarball URLs `bootstrap.sh` builds, since
  a package can exist without the pinned version being published:

  ```bash
  for p in bb-linux-x64 bb-linux-arm64 bb-darwin-x64 bb-darwin-arm64 bb-avm-linux-x64 bb-avm-linux-arm64; do
    curl -sfI "https://registry.npmjs.org/@aztec-foundation/$p/-/$p-<version>.tgz" >/dev/null || echo "MISSING: $p"
  done
  ```

### 3. Derive the paired NOIR_VERSION

`NOIR_VERSION` must be the noir release the target aztec-packages release was built
against — its `noir/noir-repo` submodule. Never guess it and never keep the old value
without checking:

```bash
sha=$(gh api "repos/AztecProtocol/aztec-packages/contents/noir/noir-repo?ref=v<version>" --jq .sha)
[ -n "$sha" ] && git ls-remote --tags https://github.com/noir-lang/noir | grep "$sha"
```

- An empty `$sha` means the lookup itself failed (wrong tag?): fix that before going on —
  an unguarded `grep ""` would list every noir tag and invite picking an arbitrary one.
- Multiple tags may point at the commit (e.g. `nightly-2026-07-31` and `v1.0.0-beta.26`):
  prefer the `v*` release tag, stripped of its `v`.
- Only a `nightly-*` tag: use it verbatim (`NOIR_VERSION` supports that form).
- No tag at all: stop and ask. A bare commit is not installable via noirup, and choosing
  a nearby release is a human call.

### 4. Rewrite the pins

```bash
./labs-aztec-toolchain/bootstrap.sh set-pins <bb-version> <noir-version>
```

Omit the noir version only if step 3 showed it unchanged. The command rewrites
`bootstrap.sh` plus every tracked copy, printing one line per updated file, then re-runs
the drift check — success is those update lines followed by no drift errors.

### 5. Refresh lockfiles

`set-pins` edits manifests only. Run plain `yarn` in both projects — after a resolutions
edit it re-resolves only the changed entries, which is the targeted update the repo's
lockfile discipline requires (`yarn up` is the wrong tool here: it edits dependency
declarations, not resolutions):

```bash
(cd yarn-project && yarn)
(cd docs && yarn)
```

Then confirm the diff is scoped to the bump: `git diff --stat` should show the files
`set-pins` reported rewriting plus the two lockfiles, and the lockfile changes only
`@aztec/*` entries. Anything beyond that means something else was stale — stop and
investigate rather than committing it. (The step-6 rebuild may additionally update
tracked generated artifacts, e.g. under `noir-contracts.js`; report those, and never run
`pin-standard-build` in response — see the root CLAUDE.md.)

### 6. Verify

- `./labs-aztec-toolchain/bootstrap.sh` — provisions the new binaries (runs the drift
  check first in pinned mode).
- Build in dependency order: `noir-projects/` then `yarn-project/` (or `make fast` from
  the root). The noir-projects build also proves the new `v<version>` tag is fetchable by
  nargo for the aztec-nr git deps.

### 7. Finish

Leave everything uncommitted and report what changed (both pins, the rewritten files,
the lockfiles) plus the verification results. If asked to commit, use
`chore: bump toolchain pins to <version>` and determine the base branch per the root
CLAUDE.md `<git_workflow>` — never assume.
