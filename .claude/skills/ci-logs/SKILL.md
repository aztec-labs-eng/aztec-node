---
name: ci-logs
description: Analyze CI logs from ci.aztec-labs.com. Use this instead of WebFetch for CI URLs.
argument-hint: <url-or-hash>
---

# CI Log Analysis

When you need to analyze logs from ci.aztec-labs.com, delegate to the `analyze-logs` subagent.

## Usage

1. **Extract the hash** from the URL (e.g., `http://ci.aztec-labs.com/e93bcfdc738dc2e0` → `e93bcfdc738dc2e0`).
   A whole run's id is decimal (`1789731399863940`); the logs nested inside it are hex. Both work with `dlog`.
   The dashboard is https-only and redirects, but the urls printed inside the logs still
   say `http://` — always take the hash and hand that to `dlog`, never fetch the url.

2. **Check the user is signed in to the dashboard** before spawning anything, by
   downloading one log yourself: `yarn ci dlog <hash> > /tmp/<hash>.log 2>&1`. Without a
   redis tunnel, the dashboard is the only route to the logs. If it says "not signed in to
   the CI dashboard", ask the user to run `! ./ci.sh dashboard-login`, which shows a code to
   approve with their Google account. Neither you nor the subagent can complete that sign-in;
   once done, it lasts until Google revokes it and every agent on the machine shares it.

3. **Spawn the `analyze-logs` subagent** using the Task tool with the hash and focus area (e.g. "errors", "test \<name>", or a custom question) in the prompt.

## Examples

**User asks:** "What failed in http://ci.aztec-labs.com/343c52b17688d2cd"

**You do:** Use the Task tool with `subagent_type: "analyze-logs"` and prompt including the hash `343c52b17688d2cd`, focus on errors, and instruction to download with `yarn ci dlog`.

**For specific test analysis:** Same approach, but set the focus to the test name.

## Do NOT

- Do NOT use WebFetch to access ci.aztec-labs.com (requires auth)
- Do NOT retry the download hoping it will work when `dlog` says "not signed in to the CI
  dashboard": the only fix is the user running `./ci.sh dashboard-login`
- Do NOT try to curl the URL directly. An http url 308s to https, and curl follows
  neither the redirect nor fails on it, so you get an empty body and a zero exit; a hash
  the dashboard does not hold answers 200 with the body `Key not found`. `dlog` handles
  both, a hand-rolled curl silently does not
- Always use the analyze-logs agent which knows how to use `yarn ci dlog`
