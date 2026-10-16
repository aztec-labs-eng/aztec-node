---
name: deflake
description: Find and fix flaky tests. Takes a ci.aztec-labs.com run (URL or hash) or a test name; with no argument, reads the recent flake reports in the #aztec3-ci Slack channel. Checks each flake against open and recent PRs, dispatches one fix agent per remaining flake, makes sure parallel flakes don't share a root cause, and opens one draft PR per fix with the log evidence and a before/after timeline. Use when asked to deflake, fix flakes, or work through the CI flake reports.
argument-hint: "[ci-url|hash|test-name] [since:<date>]"
---

# Deflake

You are the orchestrator. You collect the flakes, filter out the ones already fixed, dispatch fix agents, and check that the agents' root causes don't overlap before any PR goes up. The agents do the log reading and the fixing; keep raw logs out of this context.

Reuse these instead of re-implementing them:

- **`ci-logs`** skill and the **`identify-ci-failures`** / **`analyze-logs`** agents: downloading CI logs with `yarn ci dlog`, finding a passing run through the test's `history_*` log, and building timelines. Never WebFetch or curl a ci.aztec-labs.com URL.
- **`writing-e2e-tests`** skill (yarn-project), section *Flakiness*: the recurring root causes, and `end-to-end/scripts/deflaker.sh` for repeat runs.
- **`codex`** skill (user-level, may be absent): the adversarial reviewer. Fallback is a Fable agent.
- **`create-pr`** skill (user-level, may be absent): opening the PR. The body must still follow `pr-template.md`.

Files in this skill: `agent-brief.md` (the prompt each fix agent gets) and `pr-template.md` (the PR body).

## Step 0: Prerequisites

- `CI_PASSWORD` must be set (see `ci-logs`). If `[ -z "$CI_PASSWORD" ]`, ask the user for it before dispatching anything, and pass it to the agents. Agents cannot ask the user for it themselves.
- With no argument you need the Slack MCP (`slack_read_channel`). If it is not connected, ask the user for the runs or tests instead of guessing.
- `git fetch origin` so every comparison against `main` is fresh.

## Step 1: Collect the flakes

**Argument is a CI URL or hash**: that run is the one flake. Use `identify-ci-failures` if it is a whole-run id and you need the failing test's own log hash.

**Argument is a test name or path**: search the channel (below) for reports of that test; if there are none, ask the user for a failing run.

**No argument**: read `#aztec3-ci` (channel id `C053490AV6V`) with `slack_read_channel`, using `oldest` set to the window start. The window is `since:<date>` if given; otherwise the last 7 days. Tell the user which window you used. The Aztec CI bot posts one message per flake:

```
@<owner>: Test flaked on *<branch>*: `<env> yarn-project/end-to-end/scripts/run_test.sh simple <file> ["<test name>"]` <http://ci.aztec-labs.com/<hash>>
```

Group reports by the full command, including any env prefix (e.g. `ANVIL_HARDFORK=amsterdam`) and test-name filter, and keep every log hash and report time per group. Keep only reports on `main` unless the user asks for other branches.

## Step 2: Drop flakes that are already fixed

For each group, look for a fix before spending an agent on it:

1. Commits on `main` since the first report that touch the test file, its directory, or its fixtures:
   `git log origin/main --since=<first report date> --format='%h %ad %s' --date=iso -- <test dir> <fixture paths>`
2. PRs, open or closed in the last 14 days, mentioning the test:
   `gh pr list --state all --search "<file basename>" --json number,title,state,author,createdAt,mergedAt,url` and the same for the quoted test name, if any.
3. Recent merged PRs whose title says flake, deflake, or the test's subsystem. A fix can live in shared code that doesn't touch the test file. For example, a fix to the anvil cheat codes resolved a cross-chain test.

Classify each group:

- **Fixed**: a fix merged *after* the failing commit, and no report came in after the merge. Check with `git merge-base --is-ancestor <failing commit> <fix commit>`. The failing commit is on the `Commit:` line at the top of the test's log (`yarn ci dlog <hash> | head`), next to its `History:` link. Report it; no agent.
- **Covered by an open PR**: the PR's diagnosis matches. If the flake was reported again after the PR was opened, the PR hasn't merged yet. Dispatch a *verify-only* agent (see `agent-brief.md`) to confirm the new failure is the same mode. Do not push to someone else's PR branch.
- **Open**: nothing found. Dispatch a fix agent.

Show the user the table (test, reports, classification, PR) before dispatching.

## Step 3: Dispatch

One agent per open group, all in a single message so they run in parallel:

- `subagent_type: "general-purpose"`, `model: "opus"`, `effort: "high"` at minimum, `isolation: "worktree"`, `run_in_background: true`.
- Prompt: `agent-brief.md` with its placeholders filled in. Give each agent the list of *sibling* flakes (the other groups in this run) so it can flag a shared cause.
- If two groups are the same test file under different env variants, or the same subsystem (e.g. two slashing tests), say so in both briefs.

With a single flake, the agent may go straight from hypothesis to fix (the brief tells it so). With several, each agent stops after its hypothesis is challenged, at checkpoint A in the brief, and reports back.

## Step 4: Check for a shared root cause

When every agent has reported its hypothesis, compare them before any fix:

- Same function, file, or mechanism, e.g. two flakes both caused by the epoch cache keeping a stale committee? Then it's one fix. Pick the agent with the strongest evidence to own it. Send the others' evidence to that agent with `SendMessage` so the PR covers all of their failure logs. Tell the others to stop without a PR.
- Different causes that touch the same file: let both proceed, but tell each about the other so their diffs don't collide.
- A hypothesis that a merged or open PR already fixes: stop that agent and record which PR covers it.

Then resume each remaining agent with `SendMessage` to continue to the fix (checkpoint B in the brief).

## Step 5: Report

When the agents finish, verify each PR exists and is a draft with the `ci-draft` label (`gh pr view <n> --json isDraft,labels,baseRefName`). Report:

| Test | Reports | Outcome | PR |
|---|---|---|---|

Then:

- For each fix, whether the bug was in **application code** or in **test code / test infra**. Call out application bugs; they matter more than the flake.
- Side findings the agents left alone (possible product issues, unrelated bugs), so the user can decide whether to file them.
- Anything an agent could not verify (no local repro, mismatched toolchain).
- The agent worktrees left under `.claude/worktrees/`; they hold the PR branches, so suggest `/cleanup-worktrees` once the PRs merge.

## Rules

- Never skip a test, mark it flaky in `.test_patterns.yml`, or only raise a timeout as the fix. Relax an assertion only when it checks something the test is not meant to verify, and say why in the PR.
- PRs are always drafts, against `main`, with the `ci-draft` label.
- Don't post to Slack, comment on other people's PRs, or push to branches you didn't create without asking the user.
