#!/usr/bin/env bash
source $(git rev-parse --show-toplevel)/ci3/source_bootstrap

# Provisions the binaries the labs components build with (bb, nargo, noir-profiler, and
# optionally bb-avm and noir-execute) into bin/, from one of two sources:
#
# - Foundation mode (FND_ROOT non-empty): symlink the binaries built inside the checkout at
#   FND_ROOT (barretenberg/cpp and the noir submodule), and derive the toolchain identity
#   from that tree's source hashes. This is how the foundation repo runs the labs components
#   (as a submodule) against its own tree.
# - Pinned mode (FND_ROOT empty): download released binaries at the versions pinned below,
#   and derive the identity from this directory's committed content. This is the standalone
#   labs repo flow.
#
# Foundation mode engages when `use-local` recorded a checkout root in .fnd-root (that
# command also rewires the manifest pins, so one invocation flips the whole tree), or via
# AZTEC_TOOLCHAIN_FND_ROOT, which overrides the recording: export it empty to force pinned
# mode, or point it at a checkout to use foundation binaries without touching the manifests.
FND_ROOT=${AZTEC_TOOLCHAIN_FND_ROOT-$(cat .fnd-root 2>/dev/null || true)}

TARGET_DIR=bin
BB_BINARY=bb
BB_AVM_BINARY=bb-avm
NARGO_BINARY=nargo
NOIR_EXECUTE_BINARY=noir-execute
NOIR_PROFILER_BINARY=noir-profiler
# Records what was provisioned into TARGET_DIR (written by both build flows).
# Needed because the binaries alone cannot answer "which release is this":
# nargo only reports its base cargo version, never the nightly/release tag.
PIN_FILE=$TARGET_DIR/.pin
# Written by a driving foundation checkout (foundation mode): the content hashes of the
# components it provides, one <name>=<hash> per line. Tracked, so it is part of this
# directory's content hash.
FND_HASHES_FILE=fnd-hashes

# Pinned versions installed in pinned mode (see build_pinned; foundation mode links the
# locally built binaries instead and ignores these). These versions are also hardcoded in
# other files throughout the repo: pins.mjs owns that list. `./bootstrap.sh set-pins`
# bumps this file and every copy, and check_pin_drift fails the build on any mismatch.
# Note that BB is downloaded from the AztecProtocol/barretenberg mirror first (via bbup).
BB_VERSION=6.0.0-nightly.20260902
# NOIR_VERSION must be the noir release the $BB_VERSION aztec-packages release was built
# against (its noir submodule): the pinned nargo's output is consumed by tools from that
# release (bb, and the @aztec/noir-* js packages, which are that submodule republished).
# Skew is not detected by check_pin_drift, it surfaces in other places (e.g. the docs
# examples' runtime tests).
NOIR_VERSION=1.0.0-beta.26

# The installers and sources are fetched at build time; overridable for testing/mirroring.
# bbup comes from the same release as the bb it installs. noirup versions independently of
# noir - we need a version that ships noir-profiler (introduced in v0.1.4).
BBUP_URL=${BBUP_URL:-https://raw.githubusercontent.com/AztecProtocol/aztec-packages/v$BB_VERSION/barretenberg/bbup/bbup}
NOIRUP_URL=${NOIRUP_URL:-https://raw.githubusercontent.com/noir-lang/noirup/v0.1.4/noirup}
# bbup's artifact name is hardcoded to the plain bb, so the AVM-enabled build is taken
# straight from the release. The URLs are tried in order: the barretenberg mirror, which
# bb is also published to first, then aztec-packages.
# Empty on a machine ci3/arch does not recognize, which makes bb_avm_released_here skip bb-avm.
# Letting arch fail here would abort every command this script offers instead, including the nargo
# and noir-execute installs that have nothing to do with bb-avm.
BB_AVM_ARCH=$(arch 2>/dev/null || true)
BB_AVM_ARTIFACT=barretenberg-avm-$BB_AVM_ARCH-linux.tar.gz
BB_AVM_URLS=${BB_AVM_URLS:-"
  https://github.com/AztecProtocol/barretenberg/releases/download/v$BB_VERSION/$BB_AVM_ARTIFACT
  https://github.com/AztecProtocol/aztec-packages/releases/download/v$BB_VERSION/$BB_AVM_ARTIFACT
"}
# No noir release ships noir-execute (its `just package` recipe uploads only nargo, noir-profiler
# and noir-inspector), so it is compiled from the release source tree. Noir tags releases
# "v<semver>" and nightlies unprefixed.
NOIR_TAG=$NOIR_VERSION
[[ $NOIR_TAG == nightly-* ]] || NOIR_TAG=v$NOIR_TAG
NOIR_SOURCE_URL=${NOIR_SOURCE_URL:-https://github.com/noir-lang/noir/archive/refs/tags/$NOIR_TAG.tar.gz}

function link_tool {
  local full_path=$1
  local name=$2
  # The link must be relative: the checkout gets mounted at other paths (e.g. the aztec-up test
  # container bind-mounts it at /home/ubuntu/aztec-packages), where an absolute target dangles.
  ln -sf "$(realpath --relative-to="$TARGET_DIR" "$full_path")" "$TARGET_DIR/$name"
  echo "Created symlink: $TARGET_DIR/$name -> $full_path"
}

function check_fnd_root {
  if [ ! -f "$FND_ROOT/barretenberg/cpp/bootstrap.sh" ] || [ ! -f "$FND_ROOT/noir/bootstrap.sh" ]; then
    echo_stderr "FND_ROOT does not point at a foundation checkout (no barretenberg/cpp and noir): $FND_ROOT"
    echo_stderr "It comes from AZTEC_TOOLCHAIN_FND_ROOT if set, else from labs-aztec-toolchain/.fnd-root (recorded by use-local; remove it to return to pinned mode)."
    exit 1
  fi
}

function build_fnd {
  echo "Setting up labs' aztec toolchain from $FND_ROOT..."
  check_fnd_root

  local bb_full_path="$FND_ROOT/barretenberg/cpp/build/bin/$BB_BINARY"
  local nargo_full_path="$FND_ROOT/noir/noir-repo/target/release/$NARGO_BINARY"
  local noir_profiler_full_path="$FND_ROOT/noir/noir-repo/target/release/$NOIR_PROFILER_BINARY"

  if [ ! -f $bb_full_path ] || [ ! -f $nargo_full_path ] || [ ! -f $noir_profiler_full_path ]; then
    echo_stderr "Required binaries not found, exiting."
    echo_stderr "bb: $bb_full_path"
    echo_stderr "nargo: $nargo_full_path"
    echo_stderr "noir-profiler: $noir_profiler_full_path"
    exit 1
  fi

  # Start from an empty TARGET_DIR: a previous pinned-mode provisioning leaves real binaries
  # (and a pin record attesting them) that the symlinks below must fully replace.
  clean
  mkdir -p "$TARGET_DIR"
  link_tool "$bb_full_path" "$BB_BINARY"
  link_tool "$nargo_full_path" "$NARGO_BINARY"
  link_tool "$noir_profiler_full_path" "$NOIR_PROFILER_BINARY"

  # These may legitimately be absent: bb-avm is skipped by AVM=0 builds, and noir releases
  # don't ship noir-execute (the noir-from-release flow). Link whatever exists; a consumer of an
  # absent binary fails at the point of use.
  local optional_path
  for optional_path in \
    "$FND_ROOT/barretenberg/cpp/build/bin/$BB_AVM_BINARY" \
    "$FND_ROOT/noir/noir-repo/target/release/$NOIR_EXECUTE_BINARY"; do
    if [ -f "$optional_path" ]; then
      link_tool "$optional_path" "$(basename "$optional_path")"
    fi
  done

  # Record the full noir version: the exact tag when the submodule sits on one,
  # otherwise the binary's base version (a bare commit is not installable, so
  # it is not a useful record). Tags may be missing in shallow CI checkouts.
  git -C "$FND_ROOT/noir/noir-repo" fetch --tags --quiet 2>/dev/null || true
  local noir_full_version
  if ! noir_full_version=$(git -C "$FND_ROOT/noir/noir-repo" describe --tags --exact-match HEAD 2>/dev/null); then
    noir_full_version=$("$nargo_full_path" --version | sed -n 's/^nargo version = //p')
  fi
  {
    echo "bb=local"
    echo "noir=$noir_full_version"
  } > "$PIN_FILE"

  echo "Done."
}

# The pin record ties the provisioned binaries to the pinned versions AND their
# content hashes: matching versions alone would not detect corrupted or swapped
# binaries in TARGET_DIR. Hashes are recorded per binary and only for those
# present, so the absence of an optional binary is part of the record too.
function labs_pin_record {
  echo "bb=$BB_VERSION"
  echo "noir=$NOIR_VERSION"
  local name
  for name in "$BB_BINARY" "$BB_AVM_BINARY" "$NARGO_BINARY" "$NOIR_PROFILER_BINARY" "$NOIR_EXECUTE_BINARY"; do
    if [ -f "$TARGET_DIR/$name" ]; then
      echo "${name}_hash=$(git hash-object "$TARGET_DIR/$name")"
    fi
  done
}

# Reads a key from the pin record; empty when the record or the key is absent.
function pin_value {
  sed -n "s/^$1=//p" "$PIN_FILE" 2>/dev/null
}

# A binary is current when it exists, was provisioned from the release we pin now, and
# still hashes to what was recorded. A missing file, a moved pin, and a content mismatch
# (corruption, manual overwrite, a foundation-mode symlink) all mean it has to be fetched
# again.
function is_current {
  local name=$1 release_key=$2 pinned_version=$3
  local file=$TARGET_DIR/$name
  [ -f "$file" ] &&
    [ "$(pin_value "$release_key")" = "$pinned_version" ] &&
    [ "$(pin_value "${name}_hash")" = "$(git hash-object "$file")" ]
}

# Drops a binary that cannot be provisioned on this machine. Whatever put it there (a
# foundation-mode symlink, a manual copy) is unrelated to what this flow installs, and
# keeping it would leave the record attesting contents from a different provisioning.
function drop_unprovisionable {
  if [ -e "$TARGET_DIR/$1" ]; then
    echo "Removing $1: cannot be provisioned here, and unrelated to what was just installed."
    rm -f "$TARGET_DIR/$1"
  fi
}

function install_bb {
  local tmp=$1
  echo "Installing $BB_BINARY $BB_VERSION via bbup..."
  curl -fsSL "$BBUP_URL" -o "$tmp/bbup"
  chmod +x "$tmp/bbup"
  rm -f "$TARGET_DIR/$BB_BINARY" # Remove the destination first.
  BB_PATH="$PWD/$TARGET_DIR" "$tmp/bbup" -v "$BB_VERSION" --no-modify-path
}

# bb-avm is released for linux only, see build_release_dir in barretenberg/cpp/bootstrap.sh.
function bb_avm_released_here {
  [ "$(os)" = linux ] && [ -n "$BB_AVM_ARCH" ]
}

function install_bb_avm {
  local tmp=$1
  local archive=$tmp/$BB_AVM_ARTIFACT
  echo "Installing $BB_AVM_BINARY $BB_VERSION from release..."
  local url found=false
  for url in $BB_AVM_URLS; do
    if curl -fsSL "$url" -o "$archive"; then
      found=true
      break
    fi
    echo "Not available at $url."
  done
  if ! $found; then
    echo_stderr "Could not download $BB_AVM_ARTIFACT for v$BB_VERSION from any known release URL."
    exit 1
  fi
  rm -f "$TARGET_DIR/$BB_AVM_BINARY" # Remove the destination first.
  tar xzf "$archive" -C "$TARGET_DIR" "$BB_AVM_BINARY"
}

function install_noir {
  local tmp=$1
  echo "Installing $NARGO_BINARY/$NOIR_PROFILER_BINARY $NOIR_VERSION via noirup..."
  curl -fsSL "$NOIRUP_URL" -o "$tmp/noirup"
  chmod +x "$tmp/noirup"
  mkdir -p "$tmp/nargo_home/bin"
  NARGO_HOME="$tmp/nargo_home" "$tmp/noirup" -v "$NOIR_VERSION"
  rm -f "$TARGET_DIR/$NARGO_BINARY" "$TARGET_DIR/$NOIR_PROFILER_BINARY" # Remove the destinations first.
  cp -f "$tmp/nargo_home/bin/$NARGO_BINARY" "$TARGET_DIR/$NARGO_BINARY"
  cp -f "$tmp/nargo_home/bin/$NOIR_PROFILER_BINARY" "$TARGET_DIR/$NOIR_PROFILER_BINARY"
}

function install_noir_execute {
  local tmp=$1
  local src=$tmp/noir
  local cargo_home=$tmp/cargo-home
  local cargo_root=$tmp/cargo-root
  # The key carries the platform because this is a compiled binary, and a digest of this
  # function because the recipe below decides the output bytes (path remapping,
  # GIT_COMMIT/SOURCE_DATE_EPOCH, --locked): a recipe change must miss the cache rather
  # than restore a binary built the old way. declare -f prints bash's normalized form, so
  # the digest can differ across bash versions — the cost is a spurious rebuild, never a
  # stale hit. Keys derived from cache_content_hash get all of this for free.
  local recipe_hash
  recipe_hash=$(hash_str "$(declare -f install_noir_execute)")
  local cache_key=labs-noir-execute-$NOIR_VERSION-$recipe_hash-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m).zst

  rm -f "$TARGET_DIR/$NOIR_EXECUTE_BINARY" # Remove the destination first.

  # A build from scratch takes ~5 minutes: ~1.5 of compiling, the rest fetching the ~330
  # dependency crates, which the isolated CARGO_HOME below means paying again every time.
  # Nothing but the pinned noir version and the platform goes into the result (the build is
  # byte-reproducible, see the path remapping below), so a cached binary is as good as a
  # fresh one, down to the hash the pin records.
  if cache_download "$cache_key"; then
    echo "Restored $NOIR_EXECUTE_BINARY $NOIR_VERSION from the build cache."
    return
  fi

  echo "Building $NOIR_EXECUTE_BINARY $NOIR_VERSION from source (no release ships it)..."
  mkdir -p "$src"
  curl -fsSL "$NOIR_SOURCE_URL" | tar xz -C "$src" --strip-components=1

  # Materialise the toolchain before building. rustup installs a missing channel into the
  # shared RUSTUP_HOME, which the isolated CARGO_HOME below does not cover, and two units
  # installing the same channel at once make one roll back the other's install, leaving a
  # toolchain with no cargo in it. This is the lock the repo's other cargo builds take; hold
  # it only for the install, so the compile itself still runs alongside them.
  (
    flock -x 200
    cd "$src" && cargo --version >/dev/null
  ) 200>/tmp/rustup.lock

  # Every path cargo writes to lives under $tmp, so the trap that removes $tmp removes the
  # entire build: CARGO_HOME keeps the fetched crates out of the user's registry cache,
  # --root keeps the binary and its install manifest out of ~/.cargo/bin, and
  # CARGO_TARGET_DIR keeps the object files out of the source tree.
  # The paths are remapped out of the binary because the pin records noir-execute's content hash
  # and that hash feeds downstream cache keys: left in, $tmp's random name would make
  # every build of the same source produce different bytes.
  # GIT_COMMIT/GIT_DIRTY are what noirc_driver's build script would otherwise read from a
  # git checkout, which a release tarball is not.
  # Cargo runs from inside the source tree so rustup picks up noir's rust-toolchain.toml:
  # the workspace pins an MSRV newer than the cargo many machines have on PATH, and from
  # anywhere else the build dies on a version mismatch instead.
  (
    cd "$src"
    CARGO_HOME=$cargo_home \
    CARGO_TARGET_DIR=$tmp/cargo-target \
    RUSTFLAGS="--remap-path-prefix=$src=/noir --remap-path-prefix=$cargo_home=/cargo" \
    GIT_COMMIT=$NOIR_TAG \
    GIT_DIRTY=false \
    SOURCE_DATE_EPOCH=0 \
      cargo install --locked --path tooling/artifact_cli --bin noir-execute --root "$cargo_root"
  )

  cp -f "$cargo_root/bin/$NOIR_EXECUTE_BINARY" "$TARGET_DIR/$NOIR_EXECUTE_BINARY"
  cache_upload "$cache_key" "$TARGET_DIR/$NOIR_EXECUTE_BINARY"
}

function build_pinned {
  echo "Setting up labs' aztec toolchain..."
  echo "Pinned versions: bb $BB_VERSION, noir $NOIR_VERSION"

  mkdir -p "$TARGET_DIR"

  # Every binary is checked on its own, but the flows that provision them are coarser:
  # bbup and noirup each install their whole release in one shot, so a stale nargo also
  # refetches noir-profiler, while bb-avm (its own release artifact) and noir-execute (a source
  # build) are provisioned individually.
  # The optional binaries are only swept where they can be provisioned; elsewhere they are
  # dropped (a leftover foundation-mode symlink must not survive a pinned build) rather
  # than marked stale, which would put the no-op early return below permanently out of
  # reach on those machines.
  local fetch_bb=false fetch_bb_avm=false fetch_noir=false fetch_noir_execute=false
  is_current "$BB_BINARY" bb "$BB_VERSION" || fetch_bb=true
  is_current "$NARGO_BINARY" noir "$NOIR_VERSION" || fetch_noir=true
  is_current "$NOIR_PROFILER_BINARY" noir "$NOIR_VERSION" || fetch_noir=true
  if bb_avm_released_here; then
    is_current "$BB_AVM_BINARY" bb "$BB_VERSION" || fetch_bb_avm=true
  else
    # Absence is tolerated: its consumers (AVM proving) only run on linux anyway.
    drop_unprovisionable "$BB_AVM_BINARY"
  fi
  if command -v cargo &>/dev/null; then
    is_current "$NOIR_EXECUTE_BINARY" noir "$NOIR_VERSION" || fetch_noir_execute=true
  else
    # Absence is tolerated: its consumers fall back to the wasm simulator without it.
    drop_unprovisionable "$NOIR_EXECUTE_BINARY"
  fi

  if ! $fetch_bb && ! $fetch_bb_avm && ! $fetch_noir && ! $fetch_noir_execute; then
    echo "Toolchain matches pinned versions and hashes, nothing to download."
    return
  fi

  local tmp=$(mktemp -d)
  trap "rm -rf $tmp" EXIT

  if $fetch_bb; then
    install_bb "$tmp"
  else
    echo "$BB_BINARY $BB_VERSION already provisioned."
  fi

  if $fetch_bb_avm; then
    install_bb_avm "$tmp"
  elif bb_avm_released_here; then
    echo "$BB_AVM_BINARY $BB_VERSION already provisioned."
  fi

  if $fetch_noir; then
    install_noir "$tmp"
  else
    echo "$NARGO_BINARY/$NOIR_PROFILER_BINARY $NOIR_VERSION already provisioned."
  fi

  # The record is written before the noir-execute build, the one step that takes minutes and can
  # fail on its own (it compiles noir), so a failure there does not cost the downloads that
  # already succeeded. A stale binary goes first: the record hashes what is on disk, and an
  # interrupted run must not leave it attesting contents that are about to be replaced.
  if $fetch_noir_execute; then
    rm -f "$TARGET_DIR/$NOIR_EXECUTE_BINARY"
  fi
  labs_pin_record > "$PIN_FILE"

  if $fetch_noir_execute; then
    install_noir_execute "$tmp"
  elif command -v cargo &>/dev/null; then
    echo "$NOIR_EXECUTE_BINARY $NOIR_VERSION already provisioned."
  fi

  labs_pin_record > "$PIN_FILE"
  echo "Done."
}

function clean {
  rm -rf $TARGET_DIR
}

# The pinned versions above are also written out in files that consume the release
# directly and cannot read them from here. This asserts they all match BB_VERSION
# so a pin bump cannot leave one behind.
function check_pin_drift {
  node ./pins.mjs check
}

# Rewrites BB_VERSION/NOIR_VERSION above and every file pins.mjs tracks.
function set-pins {
  node ./pins.mjs set "$@"
}

# Points the files pins.mjs tracks at a foundation checkout instead of published releases
# and records the root so builds provision the binaries from the same checkout, for the
# foundation repo driving this repo as a submodule. Worktree-only: never commit the result.
function use-local {
  # source_base cd'd to this script's directory, so a relative argument must be rebased
  # onto the directory the user actually ran the command from.
  if [ $# -ge 1 ] && [[ "$1" != /* ]]; then
    set -- "$OLDPWD/$1" "${@:2}"
  fi
  node ./pins.mjs use-local "$@"
}

function build {
  if [ -n "$FND_ROOT" ]; then
    build_fnd
  else
    check_pin_drift
    build_pinned
  fi
}

# The full noir version (e.g. "1.0.0-beta.26" or "nightly-2026-06-02"), read from the pin
# record: the binary only reports its base cargo version, which cannot distinguish a
# nightly from the release it was cut from. Falls back to the binary when no record exists
# (a bin/ provisioned before the record was introduced).
function noir_version {
  local pinned=$(pin_value noir)
  if [ -n "$pinned" ]; then
    echo "${pinned#v}"
    return
  fi
  local nargo="$TARGET_DIR/$NARGO_BINARY"
  if [ ! -f "$nargo" ]; then
    echo_stderr "Cannot get noir version, no pin record at $PIN_FILE and no nargo (build first)."
    exit 1
  fi
  "$nargo" --version | sed -n 's/^nargo version = //p'
}

function hash {
  # The identity is this directory's committed content: in pinned mode the pins name immutable
  # releases and the provisioning logic decides what lands in bin/; in foundation mode the
  # driving checkout records the content hashes of every component it provides in
  # fnd-hashes, committed alongside the use-local rewrite. Either way the hash is computable
  # on a fresh checkout, before anything is provisioned, and does not read a provisioned byte
  # (a corrupted bin/ cannot mint a valid-looking key; bytes are verified at provision time,
  # see labs_pin_record/is_current). cache_content_hash mixes in the platform tag; dirty
  # toolchain files, or a provider that was dirty when fnd-hashes was written, disable caching.
  local content_hash
  content_hash=$(cache_content_hash "^labs-aztec-toolchain/")
  if [ "$content_hash" == "disabled-cache" ] || grep -qs "disabled-cache" "$FND_HASHES_FILE"; then
    echo disabled-cache
    return
  fi
  # What the toolchain provides on this machine, including an optional binary's absence, is
  # part of its identity and is known without provisioning: the foundation records the
  # optional binaries it built; from a release, bb-avm ships for linux only and noir-execute is
  # compiled locally exactly where cargo exists.
  local expected=""
  if [ -n "$FND_ROOT" ]; then
    check_fnd_root
    [ -f "$FND_HASHES_FILE" ] || { echo_stderr "$FND_HASHES_FILE not found: the foundation checkout writes it before building (make labs-use-local)."; exit 1; }
    expected=$(sed -n 's/^optional=//p' "$FND_HASHES_FILE")
  else
    if bb_avm_released_here; then
      expected+=" $BB_AVM_BINARY"
    fi
    if command -v cargo &>/dev/null; then
      expected+=" $NOIR_EXECUTE_BINARY"
    fi
  fi
  hash_str "$content_hash" "$expected"
}

case "$cmd" in
  "clean")
    clean
    ;;
  "ci")
    build
    ;;
  ""|"fast"|"full")
    build
    ;;
  "hash")
    hash
    ;;
  "set-pins")
    set-pins "$@"
    ;;
  "use-local")
    use-local "$@"
    ;;
  bench|bench_cmds)
    # Empty handling just to make this command valid.
    ;;
  test|test_cmds|test_download)
    ;;
  *)
    default_cmd_handler "$@"
esac
