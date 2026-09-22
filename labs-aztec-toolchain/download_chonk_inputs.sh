#!/usr/bin/env bash
# Downloads the pinned Chonk IVC input flows into chonk-pinned-flows/ next to this script.
#
# The pin names an immutable tarball of captured client-flow inputs (one ivc-inputs.msgpack
# per flow) published to the protocol artifact bucket by the foundation repo's chonk input
# update flow. A marker file records which pin the extracted tree belongs to, so re-runs are
# no-ops until the pin changes.
#
# Each capture carries the kernel verification keys of the bb that produced it, so a flow
# only proves under a bb whose circuits match. Which pin is the right one therefore follows
# which bb bootstrap.sh provisioned:
#
#   pinned mode     bb is the release named in bootstrap.sh -> chonk-inputs.hash here
#   foundation mode bb is built in the foundation checkout  -> that checkout's own pin
#
# Reading the committed hash in foundation mode pairs a freshly built bb with whatever
# capture the last standalone-labs release happened to use, and the proof fails its own
# sanity verification.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BASE_URL=${PINNED_CHONK_BASE_URL:-https://aztec-ci-artifacts.s3.us-east-2.amazonaws.com/protocol}

# Same resolution as bootstrap.sh, which picks the bb these inputs have to match.
FND_ROOT=${AZTEC_TOOLCHAIN_FND_ROOT-$(cat .fnd-root 2>/dev/null || true)}
hash_file=chonk-inputs.hash
if [ -n "$FND_ROOT" ]; then
  hash_file=$FND_ROOT/barretenberg/cpp/scripts/chonk-inputs.hash
  if [ ! -f "$hash_file" ]; then
    echo "ERROR: no chonk inputs pin in the foundation checkout: $hash_file" >&2
    echo "FND_ROOT comes from AZTEC_TOOLCHAIN_FND_ROOT if set, else from .fnd-root." >&2
    exit 1
  fi
fi

hash=$(tr -d '[:space:]' <"$hash_file")
if ! [[ "$hash" =~ ^[a-f0-9]{16}$ ]]; then
  echo "ERROR: invalid pinned chonk inputs hash '$hash' in $hash_file" >&2
  exit 1
fi

dest=chonk-pinned-flows
marker="$dest/.chonk-inputs.hash"
if [ -f "$marker" ] && [ "$(cat "$marker")" == "$hash" ]; then
  exit 0
fi

url="$BASE_URL/bb-chonk-inputs-$hash.tar.gz"
echo "Downloading pinned chonk inputs $hash from $url"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if ! curl -sSf "$url" -o "$tmp/inputs.tar.gz"; then
  echo "ERROR: failed to download pinned chonk inputs from $url" >&2
  echo "The pin in $hash_file may be stale." >&2
  exit 1
fi
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$tmp/inputs.tar.gz" -C "$dest"
printf '%s\n' "$hash" >"$marker"
