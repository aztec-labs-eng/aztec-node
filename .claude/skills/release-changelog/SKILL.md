---
name: release-changelog
description: Prepare the changelogs for a stable release - add the PR link to every entry under `## Unreleased` in CHANGELOG-DEVELOPERS.md and CHANGELOG-OPERATORS.md that lacks one, check the links already there, and turn the developer changelog's `## Unreleased` into the version's section. Use when preparing the changelog PR for a stable release.
argument-hint: "<version>"
---

# Release changelog

Prepares the changelogs for a stable release. An entry written in the PR it describes can leave out its PR link, and
this skill adds it. Finding that PR takes judgment: the commit that wrote an entry is often not the PR the entry
describes, because entries are also written in later docs PRs, in the PR that created the changelog, or reworded by
another PR. Never write or keep a link you have not checked against the entry.

## Usage

```
/release-changelog 7.0.0
```

## Step 1: Check the branch

Work on a checkout of the branch being released (`main`, or a release line such as `v6`), up to date with origin.
The version argument is required, and must equal the version in `.version-manifest.json`: stop and ask if it is
missing or does not.

## Step 2: List the entries

Only entries under `## Unreleased` count, not the example in the Format section and not released sections.

- `CHANGELOG-DEVELOPERS.md`: each top-level bullet that starts with `- **`.
- `CHANGELOG-OPERATORS.md`: each `###` heading.

For each entry, note its line, its bold sentence or heading, and the PRs it already links.

## Step 3: Find the PR each entry describes

The PR to link is the one that made the change the entry describes. Squash-merge subjects end with the PR number,
`fix(pxe): … (#743)`. A PR merged without squashing leaves commits with no number: find the PR from the commit with
`gh pr list --repo aztec-labs-eng/aztec-node --state merged --search <sha>`. Ignore subjects that end with
`(AztecProtocol/aztec-packages#N)`: they come from the history this repository was forked from, and never made a
change listed under `## Unreleased`.

1. Find the commit that wrote the entry:

   ```bash
   git log -S '<bold sentence or heading>' --reverse --format='%h %s' -- <changelog> | head -1
   ```

   If that PR's diff also contains the change itself, it is the answer. If it touches only changelogs or docs, it is
   not, and you go on to the next step.

2. Find the change from what the entry names, in the code paths it belongs to:

   - Something added: the oldest commit that mentions it,
     `git log -S '<name>' --reverse --format='%h %s' -- <paths> | head -1`.
   - Something removed or renamed: the newest commit that mentions the old name,
     `git log -S '<old name>' -n1 --format='%h %s' -- <paths>`.
   - A changed visibility, signature or default: the newest commit that matches the new form,
     `git log -G '<regex>' -n1 --format='%h %s' -- <paths>`.
   - Behaviour with no single name: search for its terms with `git log --grep` and
     `gh pr list --repo aztec-labs-eng/aztec-node --state merged --search '<terms>'`, then read the candidates.

3. Confirm the candidate with
   `gh pr view <N> --repo aztec-labs-eng/aztec-node --json title,body,mergedAt,baseRefName,headRefName` and
   `gh pr diff <N> --repo aztec-labs-eng/aztec-node`: it is merged, and its diff makes the change the entry describes.

4. A PR whose head branch is `port-<N>-to-<branch>` ports PR `N`'s change from another branch, and its subject does
   not always name `N`: `fix: require Node 24 in package engines (#674)` is the port of #673 to `v6`. Link `N`, as the
   entry on the branch `N` was merged into does. `N` is merged into that branch, and the port into this one.

5. An entry can describe a change made over several PRs. Link each PR whose diff makes part of what the entry says.

When no candidate is confirmed, or two fit equally well, leave the entry without a link and list it in the report with
the candidates. Do not guess.

## Step 4: Check the links already there

Confirm every PR an entry already links as in Step 3, items 3 to 5. Replace a link that fails with the PR Step 3
finds, and add the PRs an entry describes but does not link. List each change in the report with its evidence.

## Step 5: Write the links

A link is `[#N](https://github.com/aztec-labs-eng/aztec-node/pull/N)`. Several are separated by `, `, oldest first, and
the list is wrapped in parentheses. Change nothing else in the entry.

- `CHANGELOG-DEVELOPERS.md`: the list goes after the bold sentence's closing `**`. A period that ended the bold
  sentence moves after the list: `**`foo` is renamed `bar`** ([#123](…)). The old name …`.
- `CHANGELOG-OPERATORS.md`: the list goes at the end of the heading: `### … ([#123](…))`.

## Step 6: Turn `## Unreleased` into the version's section

Only in `CHANGELOG-DEVELOPERS.md`: rename `## Unreleased` to `## <version>`, drop its `###` and `####` subsections
that have no entries, and add a new `## Unreleased` above it with the same `###` and `####` headings the old one had,
all empty.

## Step 7: Report

Leave the changes in the working tree, and report what the PR description needs:

- each link added: the entry, the PR, and the commit or diff that shows the change;
- each link corrected: the old and new PR, and why the old one was wrong;
- each entry left without a link, with the candidates you found.
