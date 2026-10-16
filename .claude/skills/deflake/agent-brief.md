# Fix-agent brief

Fill in the `<placeholders>` and send this as the agent's prompt. For a verify-only agent (a flake an open PR may already fix), send the *Verify-only* section instead of the *Steps*.

---

You are fixing one flaky test in the aztec-node repo. Work only in your worktree. Read the root `CLAUDE.md` and `yarn-project/CLAUDE.md` first and follow them: red/green, comment rules, no AI jargon, no Claude attribution, and `git add` with explicit file names only.

## The flake

- Command: `<full command, with env prefix and test-name filter>`
- Failed runs: `<http://ci.aztec-labs.com/<hash>>` (`<report time>`), `<...>`
- Already checked by the orchestrator: `<what Step 2 found: no fix on main since <date>, no PR mentions it / related PRs: ...>`
- Sibling flakes in this run, being fixed in parallel: `<test, log hash, branch>` for each, or "none". If your root cause turns out to be in code a sibling also exercises, say so prominently.
- Mode: `<single: go straight through | multiple: stop at checkpoint A>`
- `CI_PASSWORD`: `<value, if the orchestrator had to ask for it>`

## Environment

- Your worktree starts on an unrelated branch. Run `git fetch origin main` and `git checkout -b <initials>/deflake-<slug> origin/main`. Get the initials from `git config user.initials`, or from the user's other branches.
- Keep downloads and notes in your own directory, `<scratchpad>/deflake-<slug>/`. Other agents share the scratchpad, and generic paths like `scratchpad/logs/` collide.
- The worktree has no `node_modules` and no build. `yarn build` is enough for TypeScript-only changes; e2e tests need `./bootstrap.sh` in `yarn-project`. If you skip a local run, say why.
- The pre-commit hook runs prettier from `yarn-project/node_modules`. If you haven't bootstrapped, symlink the main checkout's `yarn-project/node_modules` into your worktree for the commit and remove the link afterwards. First make sure no `node_modules` directory exists there, or the link lands inside it.
- Match CI's foundry: the version is in the failed log (`anvil --version` / `forge --version` output, or the CI image). If the local version differs, install the matching one into your scratch directory (`FOUNDRY_DIR=<dir> foundryup -i <version>`) and point `ANVIL_BIN` / `FORGE_BIN` at it. Don't install it system-wide.

## Steps

1. **Evidence.** Download every failed log with `yarn ci dlog <hash>` (see the `ci-logs` skill; never WebFetch or curl the URL). Find at least one passing run of the same test through its `history_*` log (see the `identify-ci-failures` agent). Prefer one close to the failing commit, and for env variants, the same variant. If several reports exist, check they fail the same way. Use the `identify-ci-failures` / `analyze-logs` agents for the heavy reading if you can spawn agents; otherwise grep the logs yourself. Save the key excerpts with timestamps; they go in the PR.
2. **Hypothesis.** Find the first point where the failed run diverges from the passing one, not just the final assertion. Ground the cause in both log lines and source (`file:line`), and note what evidence would disprove it. The *Flakiness* section of the `writing-e2e-tests` skill lists the usual causes; use it for leads, not answers. Before writing a fix, check `git log origin/main` again: if a fix merged after your failing commit (`git merge-base --is-ancestor <failing> <fix>`) and a passing run after it supports that, stop and report. Open no PR.
3. **Challenge.** Set up one adversarial reviewer and keep the same session for the whole task.
   - **Codex, if available** (`command -v codex`; the `codex` skill has prompt guidance). Write the prompt to a file in a fresh `mktemp -d -t codex-XXXXXXXX` directory, then run:
     `codex exec -m gpt-6-astra -c model_reasoning_effort=medium --sandbox read-only --skip-git-repo-check -C <worktree> -o <dir>/response.md - < <dir>/prompt.md > <dir>/log.txt 2>&1`.
     Capture the session id with `grep -m 1 -oE 'session id: [0-9a-f-]{36}' <dir>/log.txt`, and use `codex exec resume <id> ...` for every later turn.
   - **Otherwise a Fable agent**: `Agent` with `model: "fable"` and a `name` such as `adversary-<slug>`. Continue it with `SendMessage`. If you cannot spawn agents, report the hypothesis to the orchestrator and ask it to run the challenge.
   - Give the reviewer the facts (with `file:line`), your inferences labelled as such, the log paths, and the hypothesis. Ask it to break the hypothesis, not confirm it. Iterate in the same session until the hypothesis survives or a better one replaces it. Check its factual claims yourself; it can be wrong.
4. **Checkpoint A (multiple mode only).** Report to the orchestrator in under 200 words: the root cause, the code it lives in (`file:function`), the key evidence lines, and the reviewer's verdict. Then stop and wait. The orchestrator checks that no sibling has the same cause, then tells you to continue, merge evidence into another agent's PR, or stop.
5. **Fix.** Fix the root cause, in the test or in application code, wherever the fault is. A sleep, a timeout bump, or a retry is a fix only when the evidence says the wait itself was too short.
6. **Red/green.** Show the failure before the fix and the pass after. A real reproduction is best: e.g. run the env variants at the same time if the cause is a collision between them, or repeat-run with `end-to-end/scripts/deflaker.sh`. Failing that, write a unit or integration test that fails on `main` and passes with the fix. If neither is feasible, say so and say what stands in for it: the failed runs before and passing runs after, plus lint, build, and unit tests.
7. **Review the fix.** Send the diff to the *same* reviewer session from step 3 and ask it to try to break the fix. Fix real concerns. Drop low-value ones (unlikely edge cases, speculative hardening) and list them in your report.
8. **PR.** Commit with a Conventional Commit message, push, and open a **draft** PR against `main`, using the `create-pr` skill if available, else `gh pr create --draft --base main`. Then run `gh pr edit <n> --add-label ci-draft`. The body follows the skill's `pr-template.md` (read it). No Claude attribution.

## Final report (under 300 words)

PR URL (or why there is none), root cause in two or three sentences, whether the bug was in application code or test code, the key evidence, red/green result, the reviewer's verdicts on the hypothesis and the fix with any disagreements, what you dropped, and side findings you left alone.

## Verify-only

An open PR, `<#N: title>`, says it fixes earlier runs of this flake, but it was reported again on `<hash>`, likely because the PR hasn't merged. Read the PR (`gh pr view <N>`, `gh pr diff <N>`). Download the new log and decide, from specific log lines and source, whether it is the failure mode the PR fixes, and whether the PR's change would have prevented it. Run that conclusion past the adversarial reviewer (step 3). If it is covered, change nothing and report. If it is a different cause, run steps 4 to 8 on a new branch. Never push to the PR's branch.
