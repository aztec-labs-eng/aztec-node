#!/usr/bin/env bash
# Posts a failed release to Slack, from release.yml.
#   usage: release_failure_notify.sh <step>   (e.g. "build", "publish")
# Env: SLACK_BOT_TOKEN, TAG, ACTOR, RUN_URL, and CI_LOG_ID when the build reached an instance.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
step=${1:?usage: release_failure_notify.sh <step>}

# The release channel, not the tag name, decides whether this is worth reporting:
# a 'commit' tag is a per-commit build, which nobody wants alerts for.
channel=$(./ci3/dist_tag)
if [ "$channel" = "commit" ]; then
  echo "Canary release ($TAG); not notifying."
  exit 0
fi
case "$channel" in
  nightly) kind="Nightly release" ;;
  rc) kind="Release candidate" ;;
  *) kind="Release" ;;
esac
text="$kind $step FAILED for *${TAG}* (${ACTOR}): <${RUN_URL}|View Run>"
# Set by ci3/bootstrap_ec2 once the build reaches the instance; absent if we failed earlier.
if [ -n "${CI_LOG_ID:-}" ]; then
  text="${text} | <http://ci.aztec-labs.com/${CI_LOG_ID}|Build Log>"
fi
./ci3/slack_notify "$text" "#team-alpha-ci"
