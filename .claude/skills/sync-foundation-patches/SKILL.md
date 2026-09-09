---
name: sync-foundation-patches
description: Upstream the foundation's labs-patches series (carried in the aztec-packages checkout on top of this repo) into aztec-node as one draft PR per patch, bumping the toolchain pins with labs-aztec-toolchain/pins.mjs where a patch needs it. Use when asked to sync or upstream the foundation patches, the labs-patches series, or the foundation patch queue.
argument-hint: [foundation checkout path] [patch number ...]
---

# Sync the foundation patch queue into aztec-node

`labs-patches/` in the foundation checkout (aztec-packages, or its private fork —
wherever the directory exists) is a `git format-patch` series the foundation applies on
top of its `labs/` submodule, which is this repo. Every patch in it is a queued upstream:
it is re-applied on every pin bump until the same change lands here. Syncing turns each
unlanded patch into its own aztec-node PR. Once a PR merges and the foundation bumps its
labs pin past it, the patch drops out of the next export on its own — nothing has to be
deleted by hand on the foundation side.

With no patch numbers given, sync the whole series.

## Workflow

### Step 1: Locate the foundation checkout

Take the first candidate that has a `labs-patches/bootstrap.sh`:

1. the path given as an argument,
2. `cat labs-aztec-toolchain/.fnd-root` (written by `use-local`, gitignored),
3. siblings of this repo: `../aztec-packages-private`, `../aztec-packages`.

The `foundation` git remote is not a reliable candidate: it can point at a checkout that
does not carry the series. If nothing matches, stop and ask for the path. Call it `$FND`
below.

### Step 2: Read the series

```bash
"$FND"/labs-patches/bootstrap.sh status
```

This prints the base gitlink (the aztec-node commit the series applies to), the patch
files in apply order, and any commits in `labs/` that are not exported yet.

- **Unexported commits reported:** stop. The `.patch` files are not the whole truth; ask
  the author to run `labs-patches/bootstrap.sh export` first.
- **`*.patch.disabled`:** deliberately parked. Skip, and say so in the report.

For each patch, `head -12 <patch>` gives the author, date and subject (the subject is the
commit subject, so it is also the PR title), and `git apply --stat <patch>` gives the file
list.

### Step 3: Skip what is already synced

A patch stays in the series until the foundation bumps past it, so the series normally
contains changes that already have a PR here, and sometimes ones already merged:

```bash
git fetch origin
git log origin/main --oneline --grep="<subject>" --fixed-strings
gh pr list --repo aztec-labs-eng/aztec-node --state all --search "<subject>"
```

Skip both cases. A merged-but-still-listed patch is worth reporting: it means the
foundation's pin is behind and a `bump` there would clear it.

### Step 4: Apply each patch to a fresh branch

Work in a temporary worktree so the user's branch and working tree are untouched, and
clean it up at the end even on failure.

```bash
WORKTREE=$(mktemp -d)
git worktree add -b <prefix>/<slug> "$WORKTREE" origin/main
git -C "$WORKTREE" am --3way <patch>
```

`<slug>` is the patch filename without its number and extension. `<prefix>` follows the
repo's branch convention — the committer's initials (`fc/` in facundo's clones);
`labs-patches`' own default is `fnd/<slug>`, which marks a foundation-origin branch. Use
the same name here and on the remote.

`am` replays the patch under its original author. Never re-author it, and never squash
your own fixups into it: the foundation re-exports and re-applies that commit until it
lands, so it should stay identical to the series entry. Everything this skill adds goes in
follow-up commits.

If the patch does not apply to current `main`, it was written against the recorded gitlink
base and main has moved past it. Fall back to the foundation's own preparation, which
applies at that base, and rebase from there:

```bash
"$FND"/labs-patches/bootstrap.sh apply                        # labs/ must be checked out
"$FND"/labs-patches/bootstrap.sh upstream <n> <prefix>/<slug>
git -C "$FND"/labs push origin <prefix>/<slug>
git fetch origin <prefix>/<slug> && git -C "$WORKTREE" rebase origin/main FETCH_HEAD
```

Resolve conflicts against the intent of the change, not the literal diff — main may have
reworked the surrounding code.

**Dependent patches:** if patch N only applies on top of patch N-1, put both on one branch
in series order, or stack the second branch on the first. Never reorder the series.

### Step 5: Bump versions with pins.mjs

`labs-aztec-toolchain/pins.mjs` owns every file in this repo that carries a copy of
`BB_VERSION`/`NOIR_VERSION`. Two things a sync runs into need version changes, and both go
through it — never hand-edit a version string, and never `yarn up` a `@aztec-foundation/*`
resolution.

**(a) Drift the patch brought with it.** After `am`, in the worktree:

```bash
node labs-aztec-toolchain/pins.mjs check
```

Silence means clean. A complaint names the file, the version it found and the one it
expected: the patch carries version strings that do not match this repo's pin. Usually
that is a `use-local` rewrite (`portal:` or relative-path deps pointing into the
foundation tree) that escaped the foundation checkout, or a resolution the author added at
whatever version they had. Realign to the pin the branch is based on:

```bash
./labs-aztec-toolchain/bootstrap.sh set-pins <BB_VERSION> <NOIR_VERSION>   # values from origin/main
(cd yarn-project && yarn)
git commit -m "chore: realign the pinned versions the patch carried"
```

**(b) Foundation code the pinned release does not have.** The patch was written against
the foundation tree in `use-local` mode, so it can use an `@aztec-foundation/*` API, or bb
/ nargo behaviour, that landed after the pinned nightly. The symptom is a build that fails
to typecheck or compile against the pin, on code the patch touches. The PR then has to
carry the bump too: follow the **bump-toolchain** skill for choosing a complete release and
deriving the paired `NOIR_VERSION`, then its `set-pins` and lockfile refresh, committed
separately as `chore: bump toolchain pins to <version>`.

If no published release contains the foundation change yet, the patch cannot land here
until that nightly ships. Open the draft PR anyway and state what it is waiting for.

### Step 6: Verify

`node labs-aztec-toolchain/pins.mjs check` clean, then build what the patch touches, in
dependency order: `noir-projects/` first if it changed contracts, then `yarn build` from
inside `yarn-project/`. Compile checks only — the suite is CI's job, and CI starts when the
PR leaves draft.

### Step 7: Push a draft PR per patch

```bash
git -C "$WORKTREE" push -u origin <prefix>/<slug>
gh pr create --repo aztec-labs-eng/aztec-node --base main --head <prefix>/<slug> --draft \
  --title "<patch subject>" --body "<body>"
```

The body says the change comes from the foundation's `labs-patches` queue, names the patch
file, lists any pin bump the PR carries and why, and notes that the patch leaves the series
once this merges and the foundation bumps past it. One line per paragraph, no hard
wrapping. Attribute nothing to Claude.

### Step 8: Clean up and report

Remove every worktree created (`git worktree remove --force` if needed), then report one
line per patch: PR opened, skipped because already merged or already open, or blocked and
on what.

## Key Points

- **One PR per patch.** The series is a queue to drain, not a batch to land; a stuck patch
  must not hold up the rest.
- **The patch commit stays as exported.** Original author, original subject, fixups in
  separate commits.
- **`pins.mjs` owns pinned versions.** `set-pins` for both realignment and bumps;
  `pins.mjs check` is the guard that the patch did not smuggle in a `use-local` rewrite.
- **Never commit `use-local` state.** A `labs-aztec-toolchain/.fnd-root` in this clone
  means the local tree is in foundation mode; the branch must be built from `origin/main`,
  not from that tree.
- **The foundation side is not ours to edit.** Exporting, dropping and disabling patches,
  and moving the labs gitlink, all happen in the foundation repo.
