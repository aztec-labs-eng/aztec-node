#!/usr/bin/env bash
# Run by ci3/bootstrap_ec2 on the build instance right after checkout, before ci3/source derives
# COMMIT_HASH from HEAD. Its stdout is printed at the start of the run; its stderr only on failure.
set -euo pipefail
if [ "${RELEASE_TARGET:-}" = private ]; then
  exec scripts/apply_private_release_patch
fi
