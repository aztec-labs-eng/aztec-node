---
name: port-to-branch
description: Port a merged PR to another branch as a standalone PR, resolving conflicts if needed
argument-hint: <PR number> <target branch>
---

# Port PR to Branch

Port a merged PR to another branch (a release line like `v5`, or `main`) as a
standalone PR. Uses `scripts/port_to_branch.sh` for the happy path; when the
cherry-pick conflicts, the script commits the markers and opens a **draft** PR,
and this skill resolves the markers in a follow-up commit.

## Usage

```
/port-to-branch 12345 v5     # port to a release branch
/port-to-branch 12345 main   # forward-port to main
```

## Workflow

### Step 1: Validate Arguments

Confirm exactly two arguments: a PR number and a target branch. Abort with
"Usage: /port-to-branch <PR number> <target branch>" if not.

### Step 2: Create Isolated Worktree

Run everything in a temporary worktree so the user's branch and working tree
are never disturbed. Save the original directory to return to later.

```bash
ORIGINAL_DIR=$(pwd)
WORKTREE_DIR=$(mktemp -d)
git worktree add "$WORKTREE_DIR" HEAD
cd "$WORKTREE_DIR"
```

Always clean up the worktree at the end (Step 6), even on failure.

### Step 3: Run the Port Script

```bash
./scripts/port_to_branch.sh <PR_NUMBER> <TARGET_BRANCH>
```

The script validates the PR is merged, skips quietly if the change is already
present or a port PR already exists, cherry-picks the merge commit onto a fresh
`port-<PR_NUMBER>-to-<TARGET_BRANCH>` branch, pushes, and opens the PR.

- **Clean port (normal PR created):** skip to Step 6.
- **Conflicts (draft PR created, markers committed):** continue to Step 4.

### Step 4: Resolve Conflicts

The worktree is left on the port branch with the conflicted cherry-pick
committed. Find the markers:

```bash
grep -rln '^<<<<<<< ' --exclude-dir=.git --exclude-dir=node_modules .
```

For each conflicted file, read both sides, consult `gh pr diff <PR_NUMBER>`
for the original intent, and adapt the change to the target branch's code
state — the goal is the same behavioral change, not an exact diff match. The
draft PR body also lists binary and modify/delete conflicts, which carry no
markers; verify those files' state manually.

If changes touch `yarn-project/`, verify the build:

```bash
cd yarn-project && yarn build
```

### Step 5: Push the Resolution and Mark Ready

```bash
git add -A
git commit -m "fix: resolve port conflicts"
git push origin "port-<PR_NUMBER>-to-<TARGET_BRANCH>"
gh pr ready "port-<PR_NUMBER>-to-<TARGET_BRANCH>"
```

Marking ready is what starts CI — draft PRs run none.

### Step 6: Cleanup and Report

```bash
cd "$ORIGINAL_DIR"
git worktree remove "$WORKTREE_DIR" || git worktree remove --force "$WORKTREE_DIR"
```

Print a summary: PR ported, target branch, link to the port PR, and whether
conflicts were resolved (and how).

## Key Points

- **One PR per port**: no accumulation branch; each port is its own
  `port-<pr>-to-<target>` branch and PR, reviewed and merged independently.
- **Markers are committed on conflict**: the draft PR is the resolution
  target. Never abort and replay the cherry-pick — fix the markers in a
  follow-up commit.
- **Preserve semantic intent**: the target branch may have diverged; adapt the
  change rather than forcing the original diff.
- **Verify builds, skip tests**: compile checks only — the full suite is CI's
  job, and CI starts when the PR leaves draft.
