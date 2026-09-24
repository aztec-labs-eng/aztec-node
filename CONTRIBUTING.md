# Contributing Guidelines

These guidelines apply to the entire repository. The [docs site](./docs/) has additional guidance on writing documentation in [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md).

Please read our [disclaimer](./DISCLAIMER.md) first. To report a vulnerability, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Opening an issue

You can [open an issue] to suggest a feature or report a bug.

Before opening an issue, be sure to search through the existing open and closed issues, and consider posting a comment in one of those instead.

When requesting a new feature, include as many details as you can, especially around the use cases that motivate it. Features are prioritized according to the impact they may have on the ecosystem, so we appreciate information showing that the impact could be high.

[open an issue]: https://github.com/aztec-labs-eng/aztec-node/issues/new

## External contributions

We appreciate your interest, but we are not accepting external pull requests at this time. Unsolicited pull requests will be closed without review.

Bug reports and feature requests are always welcome as [issues](#opening-an-issue). If there is a change you would really like to make yourself, please open an issue first describing what you have in mind, and we will discuss it with you there before any code is written.

## The no-surprises rule

A code owner reviewing your PR should never be surprised by it. Every PR falls into one of three buckets:

- **Trivial**: typos, log levels, comments, renames, dependency pins, test-only fixes for an obvious flake. No issue required.
- **Obvious fix**: a bug whose fix is clear and local once you read the issue. Needs a Linear issue that describes the bug.
- **Everything else**: new features, refactors, changes to behavior, any [breaking change](#breaking-changes). The approach must be agreed with a code owner **before** you write the code.

If you are unsure which bucket a change is in, it is not trivial.

## Before you open a PR

**Link a Linear issue.** Put `Fixes A-1234` (or `Part of A-1234`) in the PR description so Linear tracks it. If there is also a related GitHub issue, link it as well (`Fixes #1234`). Only trivial changes may skip this.

**Explain the motivation.** The _why_ must live somewhere a reviewer can find it, in the Linear issue or in the PR description. The _what_ is in the diff; don't repeat it.

**Keep it small and focused.** One logical change per PR. Split refactors from behavior changes: land the pure refactor first, then the change on top of it. Use stacked PRs for large features. A PR that mixes an unrelated cleanup with a fix will be sent back.

**Test it.**

- Bug fixes include a test that fails without the fix and passes with it.
- New behavior comes with unit tests. If it crosses component boundaries (sequencer ↔ p2p ↔ archiver, L1 interaction, reorgs, pruning), add or extend an e2e test.
- If a test is flaky, file an issue for it.

**Keep docs in sync.** Update the `README.md` of any component whose design, invariants, or flow you changed. Update the [operator docs](./docs/docs-operate/) when you change anything an operator configures or observes. New config options need a description and a sensible default in the config mappings.

**Keep it observable.** New code paths log at the right level (routine events at `debug`/`verbose`, not `info`), and new failure modes emit a metric or a `warn`/`error` log someone can alert on.

**Own the diff.** You are accountable for every line, whoever or whatever wrote it. Read the diff before requesting review. Remove debug logs, commented-out code, stray formatting changes, and anything unrelated to the PR.

## PR title and description

The PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `chore:`, `refactor:`, `docs:`, `test:`, optionally scoped like `fix(p2p):`). PRs are squash-merged, so the title becomes the commit message on `main`. Mark breaking changes with `!` (e.g. `feat(archiver)!:`).

The description must include:

1. **A summary written by a human**: at least one sentence, at the top, saying what the PR does and, most importantly, why. Agent-generated detail can follow, but the opening line is yours.
2. **The linked Linear issue**, plus any related GitHub issue (unless trivial).
3. **Breaking changes**, if any (see section below).
4. **Where reviewers should focus**, if the PR is large or has a subtle part, or if there was anything contentious during design or development.

## Breaking changes

Call these out explicitly in the description, say what breaks and what the migration path is, and add an entry to the [operator changelog](./docs/docs-operate/operators/reference/changelog/) when operators are affected:

- **P2P wire format**: gossip message encoding, topics, req/resp protocols, peer scoring. Nodes on the old and new version must still interoperate, or the PR must say they can't.
- **Database schema**: archiver, world state, p2p, and slasher stores. Bump the schema version and say whether nodes need a resync.
- **Node RPC API**: public and admin JSON-RPC methods, their params and return types.
- **Operator interface**: CLI flags, environment variables, config defaults, keystore format, Helm values.
- **Protocol**: block, checkpoint, or blob format; constants; circuits; L1 contract interactions and ABIs; slashing conditions.
- **Observability**: renamed or removed metrics and log fields that dashboards or alerts depend on.

## Review

- A PR that is not a draft is assumed to be ready to merge, unless its description says otherwise. If you don't intend a PR to be merged yet, mark it as a draft.
- Code owners are requested automatically. An approval from any member of the Alpha or Fairies team, depending on whether the change affects node or client, is enough to merge.
- Push new commits in response to review instead of force-pushing, so reviewers can see what changed since their last pass. Re-request review when you are done.
- Anyone can merge an approved PR, but the author is responsible for seeing it through until it is merged: keeping CI green, resolving conflicts, and chasing reviews.
