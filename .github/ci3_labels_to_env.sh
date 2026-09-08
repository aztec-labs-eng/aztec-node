#!/usr/bin/env bash
# Determines CI mode from labels and environment variables.
# Called by ci3.yml and ci3-external.yml to set CI_MODE and related environment variables.
# Outputs environment variables to GITHUB_ENV for use in subsequent steps.
set -euo pipefail

function has_label {
  local label="$1"
  for l in "${LABELS[@]}"; do
    if [[ "$l" == "$label" ]]; then
      return 0
    fi
  done
  return 1
}

function join_by {
  local delimiter="$1"
  shift
  local result=""
  local value
  for value in "$@"; do
    if [[ -n "$result" ]]; then
      result+="$delimiter"
    fi
    result+="$value"
  done
  echo "$result"
}

function head_commit_has_marker {
  local marker="$1"
  local message
  message="$(git log -1 --pretty=%B 2>/dev/null || true)"
  grep -Eq "(^|[[:space:]])${marker}([[:space:]]|$)" <<< "$message"
}

function main {
  LABELS=("$@")
  echo "Labels: ${LABELS[*]}"

  # Compute target branch
  local target_branch
  if [ "${GITHUB_EVENT_NAME:-}" == "pull_request" ] || [ "${GITHUB_EVENT_NAME:-}" == "pull_request_target" ]; then
    target_branch="${PR_BASE_REF:-}"
  else
    target_branch="${GITHUB_REF_NAME:-}"
  fi
  target_branch="${target_branch#refs/heads/}"
  echo "TARGET_BRANCH=$target_branch" >> $GITHUB_ENV
  echo "Target branch: $target_branch"

  # Handle fail-fast override
  if has_label "ci-no-fail-fast"; then
    echo "NO_FAIL_FAST=1" >> $GITHUB_ENV
  fi

  local ci_skip_requested=0
  if has_label "ci-skip" || head_commit_has_marker "--ci-skip"; then
    ci_skip_requested=1
  fi

  local explicit_ci_mode_labels=()
  local mode_label
  for mode_label in ci-full ci-full-no-test-cache ci-docs; do
    if has_label "$mode_label"; then
      explicit_ci_mode_labels+=("$mode_label")
    fi
  done

  if [ "$ci_skip_requested" -eq 0 ] && [ "${#explicit_ci_mode_labels[@]}" -gt 1 ]; then
    echo "ERROR: Conflicting CI mode labels: $(join_by ', ' "${explicit_ci_mode_labels[@]}"). Remove all but one mode label, or use ci-skip/--ci-skip to skip CI intentionally." >&2
    exit 1
  fi

  # Determine CI mode based on event, labels, and target branch
  local ci_mode
  if [ "$ci_skip_requested" -eq 1 ]; then
    echo "WARNING: Skipping CI because a ci-skip label or --ci-skip commit marker was present. Skip takes precedence over other CI signals." >&2
    ci_mode="skip"
  elif has_label "ci-full"; then
    ci_mode="full"
  elif has_label "ci-full-no-test-cache"; then
    ci_mode="full-no-test-cache"
  # elif has_label "ci-test-network"; then
  #   ci_mode="full-no-test-cache"
  elif has_label "ci-docs"; then
    ci_mode="docs"
  elif [[ "${GITHUB_REF:-}" == "refs/heads/main" ]]; then
    # Pushes to main run full CI: with no merge queue, this is the post-merge gate and
    # the producer of the per-commit benchmark series (see BENCH_UPLOAD/BENCH_BRANCH below).
    ci_mode="full"
  else
    ci_mode="fast"
  fi

  echo "CI_MODE=$ci_mode" >> $GITHUB_ENV
  echo "CI mode: $ci_mode"

  # Benching modes run their benches on a dedicated, fixed-hardware box (stable numbers)
  # and publish the result; ci-fast never benches. For multi-instance runs only the first
  # instance keeps BENCH_UPLOAD=1 — multi_job_run forces the rest to 0 so they bench inline
  # as a breakage check without racing the upload. The destination (bench/main vs bench/prs)
  # is BENCH_BRANCH below.
  if [[ "$ci_mode" == "full" || "$ci_mode" == "full-no-test-cache" ]]; then
    echo "BENCH_UPLOAD=1" >> $GITHUB_ENV
  fi

  # Determine the branch label for benchmark publishing.
  # Only post-merge runs on main publish under "main" since those represent landed code.
  # Everything else (ci-full PRs, full runs on other branches) publishes under "prs"
  # to avoid polluting the main benchmark graphs.
  local bench_branch
  if [[ "${GITHUB_REF:-}" == "refs/heads/main" ]]; then
    bench_branch="main"
  else
    bench_branch="prs"
  fi
  echo "BENCH_BRANCH=$bench_branch" >> $GITHUB_ENV
  echo "Bench branch: $bench_branch"

  # Handle no-cache label
  if has_label "no-cache"; then
    echo "NO_CACHE=1" >> $GITHUB_ENV
    echo "Cache disabled by label"
  fi
}

main "$@"
