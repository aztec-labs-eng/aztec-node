#!/usr/bin/env bash
# Main CI3 entry point. Sets up the environment and forwards to ci.sh.
# CI mode is passed as first argument.
set -euo pipefail

# AWS credentials are handled by instance profiles on all paths.
: "${GITHUB_TOKEN:?required}"

CI_MODE="${1:?CI_MODE must be provided as first argument}"
shift

NO_CD=1 source $(git rev-parse --show-toplevel)/ci3/source_base

function setup_environment {
  echo_header "Setup"
  # Store GCP key
  if [ -n "${GCP_SA_KEY:-}" ]; then
    export GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json
    set +x
    umask 077
    printf '%s' "$GCP_SA_KEY" > "$GOOGLE_APPLICATION_CREDENTIALS"
    jq -e . "$GOOGLE_APPLICATION_CREDENTIALS" >/dev/null
    echo "GCP key stored"
  fi
  # Log SSM mode settings (defaults are baked into aws_request_instance_type).
  if [ "${CI_USE_SSH:-0}" -eq 0 ]; then
    echo "SSM mode: instance profile ${CI3_INSTANCE_PROFILE_NAME:-ci3-build-instance-profile}, SG ${CI3_SECURITY_GROUP_ID:-sg-01fe61a1c1aaeb393}"
  fi
}

function check_cache {
  echo_header "Cache Check"
  local tree_hash=$(git rev-parse HEAD^{tree})
  local cache_name="ci-success-${CI_MODE}-${tree_hash}.tar.gz"
  # Export for use by ci3_success.sh
  echo "CI_CACHE_NAME=$cache_name" >> $GITHUB_ENV
  # Main-branch runs always execute: they produce the per-commit bench/main series, so a
  # tree-hash cache hit (e.g. from a ci-full PR run of the same tree) must not skip them.
  if [[ "${GITHUB_REF:-}" == "refs/heads/main" ]]; then
    echo "Skipping the CI success-cache check for a main-branch run."
    return
  fi
  # Only whitelist some ci modes for cache.
  # E.g. we skip cache for release builds - they must always produce versioned images
  cached_ci_modes=(
    "fast"
    "full"
    "full-no-test-cache"
    "docs"
  )
  # Check if CI_MODE is in cached_ci_modes
  if [[ " ${cached_ci_modes[@]} " =~ " ${CI_MODE} " && "$GITHUB_RUN_ATTEMPT" -eq 1 ]]; then
    if cache_download "$cache_name" . 2>/dev/null && [ -f ".ci-success.txt" ]; then
      echo "Cache hit in .github/ci3.sh! Previous run: $(cat ".ci-success.txt")"
      exit 0
    fi
    echo "Cache miss in .github/ci3.sh, running CI in ${CI_MODE} mode..."
  else
    echo "Not using the .github/ci3.sh CI cache for mode $CI_MODE."
  fi
}

function main {
  echo_header "CI3 Main Script"
  echo "CI mode: $CI_MODE"
  setup_environment
  if [ "${CI_MODE}" == "skip" ]; then
    echo "WARNING: CI is being skipped in this PR." >&2
    exit 0
  fi
  check_cache
  echo_header "Run ${CI_MODE} CI"
  exec ./ci.sh "${CI_MODE}" "$@"
}

main "$@"
