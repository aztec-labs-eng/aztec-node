#!/usr/bin/env bash
NO_CD=1 source $(git rev-parse --show-toplevel)/ci3/source

# Port a merged PR to another branch as a standalone PR.
#
# Cherry-picks the PR's merge commit onto a fresh port-<pr>-to-<target> branch
# cut from origin/<target> and opens a PR against <target>. There is no
# accumulation branch: every port is its own PR, reviewed and merged
# independently.
#
# Conflicts do NOT abort the port: the conflicted cherry-pick is committed with
# its markers and the PR is opened as a DRAFT — drafts run no CI and cannot be
# merged — so the branch is a ready-made resolution target. Resolve the markers
# in a follow-up commit, push, and mark the PR ready for review.
#
# When RESULTS_FILE is set, appends one JSON line for the calling workflow:
#   {"target": "...", "status": "ported|conflicts|skipped|exists",
#    "pr_url": "...", "branch": "...", "conflicts": [...]}
#
# Usage: port_to_branch.sh [--dry-run] <pr_number> <target_branch>

usage() {
  cat >&2 <<EOF
Usage: $0 [--dry-run] <pr_number> <target_branch>

Port a merged PR to another branch as a standalone PR.

Arguments:
  pr_number       The GitHub PR number to port
  target_branch   The branch to port to (e.g., main, v5)

Options:
  --dry-run       Preview actions without pushing or creating a PR
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) export DRY_RUN=1; shift ;;
    *)
      if [[ -z "${PR_NUMBER:-}" ]]; then
        PR_NUMBER="$1"
      elif [[ -z "${TARGET_BRANCH:-}" ]]; then
        TARGET_BRANCH="$1"
      else
        echo "Error: Unexpected argument '$1'" >&2
        usage
      fi
      shift
      ;;
  esac
done
[[ -z "${PR_NUMBER:-}" || -z "${TARGET_BRANCH:-}" ]] && usage

command -v gh >/dev/null 2>&1 || { echo "Error: 'gh' CLI not found. Install from https://cli.github.com/" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Error: 'jq' not found. Install jq." >&2; exit 1; }

PORT_BRANCH="port-${PR_NUMBER}-to-${TARGET_BRANCH}"

# Emit a machine-readable result line for the calling workflow.
# Usage: report <status> [pr_url] [conflicted files...]
report() {
  local status="$1" pr_url="${2:-}"
  shift
  if [[ $# -gt 0 ]]; then shift; fi
  if [[ -n "${RESULTS_FILE:-}" ]]; then
    jq -cn --arg target "$TARGET_BRANCH" --arg status "$status" \
      --arg pr_url "$pr_url" --arg branch "$PORT_BRANCH" \
      --args '{target: $target, status: $status, pr_url: $pr_url, branch: $branch, conflicts: $ARGS.positional}' \
      -- "$@" >> "$RESULTS_FILE"
  fi
}

echo "=== Port Configuration ==="
echo "PR Number: $PR_NUMBER"
echo "Target Branch: $TARGET_BRANCH"
echo "Port Branch: $PORT_BRANCH"
echo "Dry Run: ${DRY_RUN:-0}"
echo ""

# Set a default git committer identity
if ! git config user.name &>/dev/null; then
  git config user.name "aztec-bot"
  git config user.email "tech@aztecprotocol.com"
fi

echo "Fetching PR information..."
if ! PR_INFO=$(gh pr view "$PR_NUMBER" --json title,state,body,author,url,mergeCommit); then
  echo "Error: Failed to fetch PR #$PR_NUMBER" >&2
  exit 1
fi
PR_TITLE=$(echo "$PR_INFO" | jq -r '.title')
PR_STATE=$(echo "$PR_INFO" | jq -r '.state')
PR_URL=$(echo "$PR_INFO" | jq -r '.url')
MERGE_COMMIT=$(echo "$PR_INFO" | jq -r '.mergeCommit.oid // empty')
PR_AUTHOR=$(echo "$PR_INFO" | jq -r '.author.login // empty')
if [[ -n "$PR_AUTHOR" && "$PR_AUTHOR" != "null" ]]; then
  PR_AUTHOR_EMAIL="${PR_AUTHOR}@users.noreply.github.com"
else
  echo "Warning: Could not determine PR author, using AztecBot as fallback" >&2
  PR_AUTHOR="AztecBot"
  PR_AUTHOR_EMAIL="tech@aztec-labs.com"
fi
echo "PR Title: $PR_TITLE"
echo "PR State: $PR_STATE"
echo "Author: $PR_AUTHOR"

if [[ "$PR_STATE" != "MERGED" ]]; then
  echo "Error: PR #$PR_NUMBER is not merged yet (state: $PR_STATE)" >&2
  exit 1
fi
if [[ -z "$MERGE_COMMIT" ]]; then
  echo "Error: Could not find merge commit for PR #$PR_NUMBER" >&2
  exit 1
fi

# Idempotency: re-running (workflow re-run, label re-added) must not clobber a
# port PR that may already carry manual conflict resolution.
EXISTING_PR_URL=$(gh pr list --state open --base "$TARGET_BRANCH" --head "$PORT_BRANCH" --json url --jq '.[0].url // empty' || echo "")
if [[ -n "$EXISTING_PR_URL" ]]; then
  echo "Port PR already exists: $EXISTING_PR_URL"
  report exists "$EXISTING_PR_URL"
  exit 0
fi

echo "Fetching origin/$TARGET_BRANCH and merge commit $MERGE_COMMIT..."
git fetch origin "$TARGET_BRANCH"
git fetch origin "$MERGE_COMMIT"
git checkout -B "$PORT_BRANCH" "origin/$TARGET_BRANCH"

# A squash merge has one parent; a real merge commit needs -m 1.
PARENT_COUNT=$(git rev-list --parents -n 1 "$MERGE_COMMIT" | wc -w)
CHERRY_PICK_ARGS=()
if [[ $PARENT_COUNT -gt 2 ]]; then
  echo "Merge commit has multiple parents, using -m 1 for cherry-pick"
  CHERRY_PICK_ARGS=(-m 1)
fi

CONFLICT_FILES=()
echo "Cherry-picking $MERGE_COMMIT..."
if ! git cherry-pick "${CHERRY_PICK_ARGS[@]}" "$MERGE_COMMIT" --no-edit; then
  # No unmerged paths means the patch applied to nothing: the change is already
  # present in the target (e.g. a fix that also reached the target independently,
  # or a port that bounced back). Skip it quietly instead of treating it as a
  # conflict.
  if [[ -z "$(git diff --name-only --diff-filter=U)" ]]; then
    git cherry-pick --skip >/dev/null 2>&1 || git reset --hard >/dev/null
    echo "PR #$PR_NUMBER is already present in $TARGET_BRANCH; nothing to port."
    report skipped
    exit 0
  fi
  # Commit the conflicted cherry-pick WITH its markers so the pushed branch is
  # the resolution target — the resolver (human or ClaudeBox) fixes the markers
  # in a follow-up commit instead of replaying the cherry-pick.
  mapfile -t CONFLICT_FILES < <(git diff --name-only --diff-filter=U)
  echo "Conflicts (committing with markers for manual resolution):"
  printf '%s\n' "${CONFLICT_FILES[@]}"
  git add -A
  git commit --author="$PR_AUTHOR <$PR_AUTHOR_EMAIL>" -m "$PR_TITLE

Port of #$PR_NUMBER to $TARGET_BRANCH. Cherry-picked with CONFLICT MARKERS;
resolution follows in a subsequent commit."
fi

echo "Pushing $PORT_BRANCH..."
# force-with-lease: a stale branch from an abandoned attempt (no open PR, or we
# would have exited above) is safe to overwrite.
do_or_dryrun git push --force-with-lease origin "$PORT_BRANCH"

PR_BODY_FILE=$(mktemp)
{
  echo "Ports #$PR_NUMBER to \`$TARGET_BRANCH\`."
  if [[ ${#CONFLICT_FILES[@]} -gt 0 ]]; then
    echo ""
    echo "⚠️ **The cherry-pick had conflicts, committed with their markers.** Resolve them"
    echo "in a follow-up commit, push, and mark this PR ready for review. Conflicted files:"
    printf -- '- \`%s\`\n' "${CONFLICT_FILES[@]}"
    echo ""
    echo "Binary and modify/delete conflicts cannot carry markers — double-check the files above."
  fi
  echo ""
  echo "---"
  echo ""
  echo "$PR_INFO" | jq -r '.body'
} > "$PR_BODY_FILE"

CREATE_ARGS=(
  --base "$TARGET_BRANCH"
  --head "$PORT_BRANCH"
  --title "$PR_TITLE"
  --body-file "$PR_BODY_FILE"
)
if [[ ${#CONFLICT_FILES[@]} -gt 0 ]]; then
  CREATE_ARGS+=(--draft)
fi

echo "Creating PR from $PORT_BRANCH -> $TARGET_BRANCH..."
do_or_dryrun gh pr create "${CREATE_ARGS[@]}"
rm -f "$PR_BODY_FILE"

PORT_PR_URL=$(gh pr list --state open --base "$TARGET_BRANCH" --head "$PORT_BRANCH" --json url --jq '.[0].url // empty' || echo "")
if [[ ${#CONFLICT_FILES[@]} -gt 0 ]]; then
  report conflicts "$PORT_PR_URL" "${CONFLICT_FILES[@]}"
  echo "Ported PR #$PR_NUMBER to $TARGET_BRANCH WITH CONFLICTS (draft): $PORT_PR_URL"
else
  report ported "$PORT_PR_URL"
  do_or_dryrun echo "Successfully ported PR #$PR_NUMBER to $TARGET_BRANCH: $PORT_PR_URL"
fi
