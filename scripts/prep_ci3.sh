#!/usr/bin/env bash
# Makes the ci3 submodule present and checked out at the commit this repository pins. Entry points
# run it before sourcing anything in ci3/, so a fresh clone, or one where a pull moved the pin, works
# without a manual `git submodule update`. It cannot use ci3 itself.
#
#   at the pin                           nothing; a few milliseconds, no network
#   missing                              shallow init
#   at another commit, clean, detached   moved to the pin
#   local changes, or on a branch        left alone with a warning: someone is working on ci3
#   ci3 not a submodule at this ref      nothing
#
# All output goes to stderr: entry points run inside pipelines whose stdout is data.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

function pin {
  git ls-files -s ci3 | awk '$1 == "160000" { print $2 }'
}

# The checked-out ci3 commit, or nothing when the submodule is not initialised. The .git check
# matters: in an uninitialised (empty) ci3/, `git -C ci3` would answer for this repository instead.
function current {
  [ -e ci3/.git ] && git -C ci3 rev-parse HEAD 2>/dev/null || true
}

pin=$(pin)
[ -n "$pin" ] || exit 0
[ "$(current)" == "$pin" ] && exit 0

# Entry points start in parallel (make, the bootstraps it runs): one runs git, the rest wait and
# then find nothing to do. flock is not on macOS by default; there the race is left to git's locks.
if command -v flock >/dev/null; then
  exec 9>"$(git rev-parse --git-common-dir)/prep_ci3.lock"
  flock 9
  [ "$(current)" == "$pin" ] && exit 0
fi

if [ -e ci3/.git ]; then
  if [ -n "$(git -C ci3 status --porcelain)" ] || git -C ci3 symbolic-ref -q HEAD >/dev/null; then
    echo "warning: ci3 is at $(git -C ci3 rev-parse --short HEAD), not the pinned ${pin:0:7}, and has" \
      "local changes or is on a branch; leaving it. Run 'git submodule update ci3' to use the pin." >&2
    exit 0
  fi
elif [ -n "$(ls -A ci3 2>/dev/null)" ]; then
  echo "ci3/ is not empty but is not the ci3 submodule (leftovers from a checkout where it was a" \
    "plain directory?). Move it aside, then rerun." >&2
  exit 1
fi

git submodule update --init --depth 1 ci3 >&2
