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

2. **Check `CI_PASSWORD` is set** before spawning anything. Without a redis tunnel it is
   the only credential that reaches the logs, and the subagent cannot ask for it — only
   you can. If `[ -z "$CI_PASSWORD" ]`, ask the user for the value and pass it to the
   subagent so it can export it for the download.

3. **Spawn the `analyze-logs` subagent** using the Task tool with the hash and focus area (e.g. "errors", "test \<name>", or a custom question) in the prompt.

## Examples

**User asks:** "What failed in http://ci.aztec-labs.com/343c52b17688d2cd"

**You do:** Use the Task tool with `subagent_type: "analyze-logs"` and prompt including the hash `343c52b17688d2cd`, focus on errors, and instruction to download with `yarn ci dlog`.

**For specific test analysis:** Same approach, but set the focus to the test name.

## Do NOT

- Do NOT use WebFetch to access ci.aztec-labs.com (requires auth)
- Do NOT guess or invent a `CI_PASSWORD` value, and do not retry the download hoping it
  will work: `dlog` exits with "CI_PASSWORD not set for http fallback" and the only fix
  is to ask the user
- Do NOT try to curl the URL directly. An http url 308s to https, and curl follows
  neither the redirect nor fails on it, so you get an empty body and a zero exit; a hash
  the dashboard does not hold answers 200 with the body `Key not found`. `dlog` handles
  both, a hand-rolled curl silently does not
- Always use the analyze-logs agent which knows how to use `yarn ci dlog`
