# Deflake PR body

Title: a Conventional Commit, under 70 characters, describing the fix rather than the symptom. For example, `test(e2e): give circuit_recorder a private recording directory`, not `fix flaky circuit_recorder`.

Body, in this order. Keep each section short. The before/after timeline is for teaching, so simplify it to the few events that matter.

````markdown
<One sentence: which test flaked, and what this PR changes.>

## Failed runs

- <http://ci.aztec-labs.com/<hash>> (main @ <short sha>, <date>)
- <another, if several>

## Evidence

<The log lines that show the failure, trimmed to timestamp, actor, and message. Point out the one that matters.>

```
10:52:11.874  INFO  e2e            [default] removed ./circuit_recordings
10:52:12.056  INFO  e2e            [amsterdam] sent tx
10:52:12.300  FAIL  circuit_recorder.test.ts:40  expect(dirExists).toBe(true)  Received: false
```

## Cause

<Two to four sentences: what goes wrong and in which code (`file:line`). Say whether the bug is in application code or in the test.>

## Timeline

<The sequence from the failed log that supports the cause, compared with a passing run where useful.>

| Time | Failed run | Passing run |
|---|---|---|
| +0.0s | ... | ... |

## Fix

<What changed, at the level of behavior. One short paragraph or a few bullets.>

## Why it works

<Why the failure sequence above can no longer happen. Address the specific step in the timeline that the fix removes or reorders.>

## Before / after

<A simplified timeline of the same scenario, before and after the fix. Use plain names (node A, slot 15, anvil), not hashes.>

```
Before:  A starts ── B starts ── A finishes, deletes shared dir ── B checks dir → missing ✗
After:   A starts (dir A) ── B starts (dir B) ── A deletes dir A ── B checks dir B → present ✓
```

## Testing

<Red/green: what failed before the fix and passes after, or why there was no local reproduction and what stands in for it.>
````

If the PR also fixes a sibling flake with the same root cause, add that flake's runs under *Failed runs* and one line under *Evidence* showing that it fails the same way.
