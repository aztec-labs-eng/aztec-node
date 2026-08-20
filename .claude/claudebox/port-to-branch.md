# ClaudeBox Port Conflict Resolution

Instructions for ClaudeBox when a `port-to-branch.yml` cherry-pick hit
conflicts. The workflow has already committed the conflicted cherry-pick WITH
ITS MARKERS on a `port-<PR_NUMBER>-to-<TARGET_BRANCH>` branch and opened a
draft PR. Your job is to resolve the markers in a follow-up commit, push, and
mark the PR ready for review. Do NOT replay the cherry-pick and do NOT create
a new branch or PR.

## Context

You will receive a prompt like:
> Port of PR #NNN (title) to BRANCH has conflicts. The conflicted cherry-pick
> is committed WITH ITS MARKERS on branch port-NNN-to-BRANCH, draft PR: URL.

Variables to extract from the prompt:
- `PR_NUMBER`: the original PR number
- `TARGET_BRANCH`: the branch being ported to
- `PORT_BRANCH`: `port-<PR_NUMBER>-to-<TARGET_BRANCH>` (stated in the prompt)
- `PORT_PR_URL`: the draft PR to finish

## Constraints

You are running inside ClaudeBox. You do **not** have `gh` CLI or `git push`.
Use MCP tools instead: `github_api`, `git_fetch`, `create_pr`, `update_pr`.

`update_pr` pushes from the current HEAD onto the PR's branch. If HEAD is on
the wrong branch, unrelated commits will leak into the PR. **Always verify
your branch before pushing.**

## Workflow

### 1. Check Out the Port Branch

```bash
git_fetch(args="origin ${PORT_BRANCH}")
git checkout -B "${PORT_BRANCH}" FETCH_HEAD
```

Verify with `git log --oneline -3`: the tip commit is the conflicted
cherry-pick (its message says "CONFLICT MARKERS").

### 2. Find and Resolve the Conflicts

The draft PR body lists the conflicted files. Search for markers to confirm:

```bash
grep -rn '^<<<<<<< ' --exclude-dir=.git --exclude-dir=node_modules . || true
```

Get the original PR diff for reference:

```
github_api(method="GET", path="repos/aztec-labs-eng/aztec-node/pulls/<PR_NUMBER>",
           accept="application/vnd.github.v3.diff")
```

For each conflicted file:
- Read the conflict markers and understand both sides.
- Understand the intent from the original PR diff.
- Resolve by adapting the change to the target branch's code state. The goal
  is the same behavioral change, not an exact diff match.

**Also check the PR body's conflict list for binary or modify/delete
conflicts** — those carry no text markers, so verify the file state matches
the original PR's intent (deleted, replaced, etc.).

### 3. Verify Build (if practical)

If changes are in `yarn-project/`:

```bash
cd yarn-project && yarn build
```

Fix any build errors from the adaptation.

### 4. Commit and Push the Resolution

```bash
git add -A
git commit -m "fix: resolve port conflicts"
```

Verify HEAD is on `${PORT_BRANCH}` with only the cherry-pick and resolution
commits on top of `origin/${TARGET_BRANCH}`, then push the resolution onto
the existing draft PR with `update_pr`.

### 5. Mark the PR Ready

Marking a PR ready for review is GraphQL-only:

```
github_api(method="POST", path="graphql", body={"query":
  "mutation { markPullRequestReadyForReview(input: {pullRequestId: \"<NODE_ID>\"}) { pullRequest { isDraft } } }"})
```

Get `<NODE_ID>` from `github_api(method="GET", path="repos/aztec-labs-eng/aztec-node/pulls/<PORT_PR_NUMBER>")`
(the `node_id` field). If the mutation is unavailable, say so in the final
report so a human marks it ready — CI only runs once the PR leaves draft.

### 6. Report

Use `respond_to_user` with a short summary:
- Link to the port PR
- Which conflicts were found and how each was resolved
- Whether the PR was marked ready or still needs it
