---
name: sync-foundation-patches
description: Sync the foundation's labs-patches series (carried in aztec-packages on top of this repo) into aztec-node as one draft PR, a commit per patch, bumping the toolchain pins with labs-aztec-toolchain/pins.mjs. Use when asked to sync or upstream the foundation patches, the labs-patches series, or the foundation patch queue.
argument-hint: [patch number ...]
---

# Sync the foundation patch queue into aztec-node

`labs-patches/` in **AztecProtocol/aztec-packages** is a `git format-patch` series the
foundation applies on top of its `labs/` submodule, which is this repo. Every patch in it
is a queued upstream: it is re-applied on every pin bump until the same change lands here.
Syncing replays the series onto `main` and opens the PR that drains it. Once the PR merges
and the foundation bumps its labs pin past those commits, the patches drop out of the next
export on their own — nothing is deleted by hand on the foundation side.

**Default: one draft PR for the whole series, one commit per patch.** The patches are a
dependent chain (later ones build on earlier ones), so splitting them is only worth it when
asked, or when one patch is blocked and the rest should not wait — then take the
contiguous prefix that applies, and say which patches were left behind.

With patch numbers given as arguments, sync only those, still in series order. Expect a
non-contiguous subset to conflict or fail outright — the chain is dependent — and say so
rather than quietly pulling in the patches it turned out to need.

## Workflow

### Step 1: Read the series from GitHub

No aztec-packages checkout is needed — the series, the patch bodies and the recorded base
all come from the contents API on the default branch (`next`):

```bash
FND=AztecProtocol/aztec-packages
gh api "repos/$FND/contents/labs-patches?ref=next" --jq '.[].name' | grep '\.patch$' | sort
gh api "repos/$FND/contents/labs?ref=next" --jq .sha        # the base gitlink
```

Take the files in **name order**, not by number: the numbering has gaps where a patch was
dropped. `*.patch.disabled` is deliberately parked — skip it, and say so in the report.

Patch numbers given as arguments narrow the listing to those patches here, before anything
is downloaded: the set built in this step is the set that gets applied, and it must never
be re-widened by a wildcard later on.

Download the set into a scratch directory (the raw Accept header is what returns the file
whole; some patches are megabytes of regenerated artifacts):

```bash
gh api -H "Accept: application/vnd.github.raw" \
  "repos/$FND/contents/labs-patches/<name>?ref=next" > "$SCRATCH/<name>"
```

`head -12` on a patch gives its author, date and subject (the subject is the commit
subject); `git apply --stat` gives the file list.

Before replaying, make sure Git has every non-empty preimage blob named by the patches. An
exported patch can depend on an intermediate blob created by an earlier queue commit that is
not reachable from this repo's origin, causing `git am --3way` to stop with `invalid object` or
`Repository lacks necessary blobs`. Missing blobs are available from the foundation's
aztec-node fork:

```bash
sed -n 's/^index \([0-9a-f]\{40\}\)\.\.[0-9a-f]\{40\}.*/\1/p' "$SCRATCH"/*.patch | sort -u |
  while read -r blob; do
    [ "$blob" = 0000000000000000000000000000000000000000 ] && continue
    git cat-file -e "$blob" 2>/dev/null && continue
    actual=$(gh api "repos/AztecProtocol/aztec-node/git/blobs/$blob" --jq .content |
      tr -d '\n' | base64 -d | git hash-object -w --stdin)
    [ "$actual" = "$blob" ] || { echo "blob hash mismatch: expected $blob, wrote $actual" >&2; exit 1; }
  done
```

Do this before `git am`, not after it stops: the stopped patch has to be applied manually
before `git am --continue`, while preloading keeps the normal replay path intact. A 404 is
not permission to apply without a three-way base; stop and identify which fork or commit
holds the blob.

### Step 2: Branch off main, and drop what is already here

Work in an independent, clean aztec-node checkout — never in one that is a submodule of
another repo, where the build and the pins are wired to that parent. A plain branch is
enough; no worktree. If the tree is dirty, stop and ask rather than stashing or reverting:
`git checkout -b` carries uncommitted changes onto the branch and into the sync.

```bash
git fetch origin
git checkout -b <prefix>/sync-foundation-patches origin/main
```

`<prefix>` follows the repo's branch convention — the committer's initials (`fc/` in
facundo's clones).

A patch stays in the series until the foundation bumps past it, so the series routinely
lists changes that already landed here. Test the content, not the commit message: a patch
whose changes are already on `main` reverse-applies cleanly to it, whatever the commit it
arrived in was called. The tree is `main` at this point, which is what makes the test mean
anything:

```bash
git apply --check --reverse <patch>    # exit 0 = already here, drop it
```

A subject search is a hint worth printing beside that, never the decision:

```bash
git log origin/main --oneline --fixed-strings --grep="<subject>"
```

The subject cannot settle it in either direction. Sync PRs are squash-merged, so the
individual patch subjects do not survive on `main` and a landed patch matches nothing; and
a subject can equally match a different or partial change that shares its wording.

Report every patch dropped this way: a merged-but-still-listed patch means the foundation's
pin is behind and a `bump` there would clear it. A patch that neither reverse-applies nor
applies forward is a genuine conflict — Step 3's problem, not a reason to drop it.

### Step 3: Apply the series onto main

```bash
git am --3way "$SCRATCH"/<patch> "$SCRATCH"/<patch> ...   # the set from Step 2, in series order
```

`am` replays each patch as its own commit under its original author. Never re-author them,
never squash them together, and never fold your own fixups into them: the foundation
re-exports and re-applies those commits until they land, so they should stay identical to
the series entries. Everything this skill adds goes in follow-up commits.

**Conflicts are yours to resolve.** `am` stops on the offending patch with the markers in
the tree; main has moved on since the recorded base, so resolve against the intent of the
change rather than either literal side, then `git add` and `git am --continue`. Never
`git am --skip` merely to get past a conflict — it can silently drop a patch the rest of
the chain needs — and never abort and restart. There is one narrow exception: later
patches may have rewritten an earlier patch enough that its isolated reverse check failed,
while current main already contains its final behavior. After resolving every conflict
against that newer implementation, `git diff --cached --quiet` proves there is no residual
delta; only then skip it and report it as dropped as already landed after dependent replay.
Docs files that both sides append to (the migration notes especially) are the usual case,
and both sides' entries normally belong in the result.

Write down each resolution as you make it: which patch, which file, which side you kept and
why. That list goes in the PR body (Step 6) — a reviewer must be able to check the merge
without re-deriving it.

### Step 4: Bump the pins with pins.mjs

The patches were written in the foundation's own tree, against its unreleased code rather
than a published release, so they can rely on `@aztec-foundation/*` APIs, or bb / nargo
behaviour, newer than this repo's pin. The sync therefore carries a pin bump to the latest
foundation nightly and the noir release that nightly was built against, as its own commit
on top of the patch commits.

Follow the **bump-toolchain** skill for the version work: it covers picking the latest
complete nightly (they can publish partially), deriving the paired `NOIR_VERSION` from that
release's noir submodule, and the verification. The rewrite itself is:

```bash
./labs-aztec-toolchain/bootstrap.sh set-pins <bb-version> <noir-version>
(cd yarn-project && yarn)
(cd docs && yarn)
git commit -m "chore: bump toolchain pins to <bb-version>"
```

If the latest complete nightly is already `BB_VERSION`, there is no bump commit. Still
check the paired Noir release. Before changing a local `NOIR_VERSION` that is newer than
the nightly's submodule, inspect the commit that introduced the skew: it may be a deliberate
compatibility choice. Report an intentional skew instead of silently downgrading it.

`pins.mjs` rewrites manifests only — `BB_VERSION`/`NOIR_VERSION` in
`labs-aztec-toolchain/bootstrap.sh`, the `yarn-project/package.json` resolutions,
`docs/package.json`, every `Nargo.toml`, and `docs/examples/ts/*/config.yaml`. It never
runs yarn, so `yarn-project/yarn.lock` and `docs/yarn.lock` are yours to refresh with a
plain `yarn` (`yarn up` is the wrong tool: it rewrites dependency declarations, while the
pins live in the resolutions block — a plain install after a resolutions edit re-resolves
only the entries that changed, which is the targeted update the repo's lockfile discipline
requires). Check that: the lockfile diff must be `@aztec-foundation/*` entries and what
they pull in, nothing else. Anything wider means something was already stale — stop and
find out what rather than carrying it in the sync. `set-pins` re-runs the drift check
itself: success is one update line per rewritten file and nothing after them.

Never hand-edit a pinned version and never `yarn up` an `@aztec-foundation/*` resolution —
`pins.mjs` owns every copy of those versions.

If the foundation change a patch needs is not in any published nightly yet, the series
cannot land until that nightly ships. Open the draft PR anyway and state what it is waiting
for.

### Step 5: Verify

Provision the pinned toolchain with `./labs-aztec-toolchain/bootstrap.sh`, then build
`noir-projects/` and run `./bootstrap.sh` from inside `yarn-project/` — never `yarn build`, which
recompiles TypeScript without regenerating `constants/src/constants.gen.ts` and the other
generated inputs, so a pin bump shows up as type errors about members the foundation
release does have. A clean checkout needs the Noir contract targets even when the residual
patch only changes TypeScript, because the yarn bootstrap consumes those artifacts. Compile
checks only — the suite is CI's job, and CI starts when the PR leaves draft.

### Step 6: Push the draft PR

```bash
git push -u origin <prefix>/sync-foundation-patches
gh pr create --repo aztec-labs-eng/aztec-node --base main --draft \
  --label ci-full --label ci-no-fail-fast \
  --title "chore: sync the foundation patch queue" --body-file "$SCRATCH/pr-body.md"
```

Both labels go on at creation. `ci-full` runs the extended suite and the benchmarks, which
a default run skips; `ci-no-fail-fast` keeps the remaining jobs going past the first
failure, so one bad patch in the chain does not hide what the others break. Neither takes
effect while the PR is a draft — ci3.yml gates on `draft == false` or a `ci-draft` label —
so the run starts at `gh pr ready`; add `ci-draft` too if it should start before then.

The body carries, in this order: the patches in series order with their subjects; any
dropped as already-landed or left behind as blocked, and why; **every conflict resolved,
one line each — patch, file, what the resolution kept and why**; the pin bump and the
release it moves to; and a note that these patches leave the foundation's series once this
merges and the foundation bumps past it. One line per paragraph, no hard wrapping.
Attribute nothing to Claude.

### Step 7: Report

One line per patch: applied, applied with a conflict resolved, dropped as already merged,
skipped as disabled, or blocked and on what. Plus the pin versions and the build result.

## Key Points

- **The patch commits stay as exported.** Original author, original subject, one commit per
  patch; conflict resolutions land inside the `am` for the patch they belong to, everything
  else in separate commits on top.
- **Every conflict resolution is explained in the PR body.** The reviewer is checking a
  merge they did not perform.
- **`pins.mjs` owns pinned versions, not lockfiles.** `set-pins` rewrites the manifests;
  refreshing `yarn-project/yarn.lock` and `docs/yarn.lock` is a separate `yarn` run.
- **A patch that re-pins the standard contracts is not routine.** If the series moves
  `noir-projects/noir-contracts/pinned-standard-contracts.tar.gz` or
  `standard_addresses.nr`, it changes the canonical standard-contract addresses. Keep the
  patch — it is the foundation's deliberate call, and dropping it would strand the rest of
  the chain — but flag it at the top of the PR body so the redeploy is a human decision, and
  never run `pin-standard-build` yourself in response to fallout from it.
- **The foundation side is not ours to edit.** Exporting, dropping and disabling patches,
  and moving the labs gitlink, all happen in aztec-packages.
