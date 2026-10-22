#!/usr/bin/env bash
# Builds <version>.tar.xz in this directory from the @aztec-labs packages published on npm, enabling the
# backwards-compat sweep for that version once committed.
# Usage: ./add_version.sh <version>   e.g. ./add_version.sh 6.0.1
set -euo pipefail

version=${1:?usage: $0 <version> (e.g. 6.0.1)}
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: '$version' is not a stable X.Y.Z version." >&2
  exit 1
fi

out_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
out="$out_dir/$version.tar.xz"

# The deterministic flags below are GNU tar's; macOS ships BSD tar (brew install gnu-tar).
tar_bin=tar
if ! tar --version 2>/dev/null | grep -q GNU; then
  tar_bin=gtar
  command -v gtar >/dev/null || { echo "ERROR: GNU tar required (brew install gnu-tar)." >&2; exit 1; }
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"

for p in noir-contracts.js noir-test-contracts.js accounts; do
  # Force the public registry: some environments (e.g. CI) point the @aztec-labs scope elsewhere.
  npm pack "@aztec-labs/$p@$version" --@aztec-labs:registry=https://registry.npmjs.org/ --quiet
  mkdir -p "$version/$p"
  tar -xzf "aztec-labs-$p-$version.tgz"
  cp -r package/artifacts "$version/$p/artifacts"
  rm -rf package
done
find "$version" -type f ! -name '*.json' -delete

# Deterministic output: regenerating from the same npm packages yields a byte-identical file. --mode keeps the
# directory permissions from following the caller's umask, and --threads=1 keeps the xz stream layout from following
# the xz version's threading default.
$tar_bin --sort=name --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' --mtime='2000-01-01 00:00:00Z' \
    -cf - "$version" | xz -9 --threads=1 > "$version.tar.xz"

if [ -f "$out" ]; then
  if cmp -s "$version.tar.xz" "$out"; then
    echo "$out already exists and is byte-identical. Nothing to do."
    exit 0
  fi
  echo "ERROR: $out exists but differs from the freshly built tarball." >&2
  exit 1
fi
mv "$version.tar.xz" "$out"
echo "Created $out. Commit it to enable the compat sweep for $version."
