---
name: sync-foundation-patches
description: Sync the foundation's labs-patches series (carried in aztec-packages on top of this repo) into aztec-node as one draft PR, a commit per patch, bumping the toolchain pins with labs-aztec-toolchain/pins.mjs where a patch needs it. Use when asked to sync or upstream the foundation patches, the labs-patches series, or the foundation patch queue.
argument-hint: [patch number ...]
---

# Sync the foundation patch queue into aztec-node

`labs-patches/` in **aztec-packages** is a `git format-patch` series the foundation applies
on top of its `labs/` submodule, which is this repo. Every patch in it is a queued
upstream: it is re-applied on every pin bump until the same change lands here. Syncing
replays the series onto `main` and opens the PR that drains it. Once the PR merges and the
foundation bumps its labs pin past those commits, the patches drop out of the next export
on their own — nothing is deleted by hand on the foundation side.

**Default: one draft PR for the whole series, one commit per patch.** The patches are a
dependent chain (later ones build on earlier ones), so splitting them is only worth it when
asked, or when one patch is blocked and the rest should not wait — then take the
contiguous prefix that applies, and say which patches were left behind.

With patch numbers given as arguments, sync only those (still in series order).

## Workflow

### Step 1: Read the series from GitHub

No aztec-packages checkout is needed — the series, the patch bodies and the recorded base
all come from the API. The series lives on the default branch (`next`) of the **public**
repo; the private fork carries the tooling but not the patches.

```bash
FND=AztecProtocol/aztec-packages
gh api "repos/$FND/contents/labs-patches?ref=next" --jq '.[].name' | grep '\.patch$' | sort
gh api "repos/$FND/contents/labs?ref=next" --jq .sha        # the base gitlink
```

Take the files in **name order**, not by number: the numbering has gaps where a patch was
dropped. `*.patch.disabled` is deliberately parked — skip it, and say so in the report.

Download each into a scratch directory (the raw Accept header is what returns the file
whole; some patches are megabytes of regenerated artifacts):

```bash
gh api -H "Accept: application/vnd.github.raw" \
  "repos/$FND/contents/labs-patches/<name>?ref=next" > "$SCRATCH/<name>"
```

`head -12` on a patch gives its author, date and subject (the subject is the commit
subject); `git apply --stat` gives the file list.

### Step 2: Drop what is already here

A patch stays in the series until the foundation bumps past it, so the series routinely
lists changes that already landed here:

```bash
git fetch origin
git log origin/main --oneline --fixed-strings --grep="<subject>"
```

Drop those from the set before applying. Report them: a merged-but-still-listed patch
means the foundation's pin is behind and a `bump` there would clear it.

### Step 3: Apply the series onto main

A plain branch in the current checkout is enough; make sure the tree is clean first.

```bash
git checkout -b <prefix>/sync-foundation-patches origin/main
git am --3way "$SCRATCH"/*.patch
```

`am` replays each patch as its own commit under its original author. Never re-author them,
never squash them together, and never fold your own fixups into them: the foundation
re-exports and re-applies those commits until they land, so they should stay identical to
the series entries. Everything this skill adds goes in follow-up commits.

`<prefix>` follows the repo's branch convention — the committer's initials (`fc/` in
facundo's clones).

On conflict, `am` stops on the offending patch with the markers in the tree. Resolve
against the intent of the change (main has moved on since the recorded base), then
`git add` and `git am --continue`. Do not abort and restart: `git am --skip` silently drops
a patch the rest of the chain may need. Docs files that both sides append to — the
migration notes especially — are the usual conflict, and both sides' entries normally
belong in the result.

### Step 4: Bump versions with pins.mjs

`labs-aztec-toolchain/pins.mjs` owns every file in this repo that carries a copy of
`BB_VERSION`/`NOIR_VERSION`. Two things a sync runs into need version changes, and both go
through it — never hand-edit a version string, and never `yarn up` an
`@aztec-foundation/*` resolution.

**(a) Drift the series brought with it.** After the series is applied:

```bash
node labs-aztec-toolchain/pins.mjs check
```

Silence means clean. A complaint names the file, the version found and the version
expected: a patch carries version strings that do not match this repo's pin. Usually that
is a `use-local` rewrite (`portal:` or relative-path deps pointing into the foundation
tree) that escaped the foundation checkout, or a resolution added at whatever version the
author had. Realign to the branch's own pin rather than editing the files:

```bash
./labs-aztec-toolchain/bootstrap.sh set-pins <BB_VERSION> <NOIR_VERSION>   # values from origin/main
(cd yarn-project && yarn)
git commit -m "chore: realign the pinned versions the patches carried"
```

**(b) Foundation code the pinned release does not have.** The patches were written against
the foundation tree in `use-local` mode, so they can use an `@aztec-foundation/*` API, or
bb / nargo behaviour, that landed after the pinned nightly. The symptom is a build that
fails to typecheck or compile against the pin, on code a patch touches. The PR then has to
carry the bump too: follow the **bump-toolchain** skill for choosing a complete release and
deriving the paired `NOIR_VERSION`, then its `set-pins` and lockfile refresh, committed
separately as `chore: bump toolchain pins to <version>`.

If no published release has the foundation change yet, the series cannot land until that
nightly ships. Open the draft PR anyway and state what it is waiting for.

### Step 5: Verify

`node labs-aztec-toolchain/pins.mjs check` clean, then build in dependency order for what
the series touches: `noir-projects/` first if contracts changed, then `yarn build` from
inside `yarn-project/`. Compile checks only — the suite is CI's job, and CI starts when the
PR leaves draft.

### Step 6: Push the draft PR

```bash
git push -u origin <prefix>/sync-foundation-patches
gh pr create --repo aztec-labs-eng/aztec-node --base main --draft \
  --title "chore: sync the foundation patch queue" --body "<body>"
```

The body lists the patches in order with their subjects, names any that were dropped as
already-landed or left behind as blocked, describes any pin bump the PR carries and why,
and calls out conflicts that were resolved by hand. It also notes that these patches leave
the foundation's series once this merges and the foundation bumps past it. One line per
paragraph, no hard wrapping. Attribute nothing to Claude.

### Step 7: Report

One line per patch: applied, dropped as already merged, skipped as disabled, or blocked and
on what. Plus the pin state and the build result.

## Key Points

- **The patch commits stay as exported.** Original author, original subject, one commit per
  patch, fixups in separate commits.
- **`pins.mjs` owns pinned versions.** `set-pins` for both realignment and bumps;
  `pins.mjs check` is the guard that no patch smuggled in a `use-local` rewrite.
- **A patch that re-pins the standard contracts is not routine.** If the series moves
  `noir-projects/noir-contracts/pinned-standard-contracts.tar.gz` or
  `standard_addresses.nr`, it changes the canonical standard-contract addresses. Keep the
  patch — it is the foundation's deliberate call, and dropping it would leave the series
  unapplied — but flag it at the top of the PR body so the redeploy is a human decision,
  and never run `pin-standard-build` yourself in response to fallout from it.
- **Never commit `use-local` state.** A `labs-aztec-toolchain/.fnd-root` in this clone means
  the local tree is in foundation mode; the branch must come from `origin/main`, not from
  that tree.
- **The foundation side is not ours to edit.** Exporting, dropping and disabling patches,
  and moving the labs gitlink, all happen in aztec-packages.
