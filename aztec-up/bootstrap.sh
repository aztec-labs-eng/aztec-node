#!/usr/bin/env bash
source $(git rev-parse --show-toplevel)/ci3/source_bootstrap

hash=$(hash_str \
  $(cache_content_hash ^aztec-up/) \
  $(../yarn-project/bootstrap.sh hash))

# Bare aliases ("nightly", "latest") resolve to this major version.
DEFAULT_MAJOR_VERSION=${AZTEC_TOOLCHAIN_DEFAULT_MAJOR_VERSION:-5}

# Tool versions baked into the install artifacts (uploaded to S3 on release).
# The installer reads exactly these keys: noir (noirup), foundry (foundryup),
# node (nvm minimum version).
function versions {
  echo "noir: $("$root"/labs-aztec-toolchain/bootstrap.sh noir_version)"
  echo "foundry: $(anvil --version | head -n1 | sed -E 's/anvil Version: ([0-9.]+).*/\1/')"
  echo "node: $(node --version | cut -d 'v' -f 2)"
}

function build {
  # Noop if user doesn't have docker.
  if ! command -v docker &>/dev/null; then
    echo "Docker not installed. Skipping..."
    return
  fi

  # Create versions file so we know what to install.
  versions > ./bin/0.0.1/versions
  echo "Versions:"
  cat ./bin/0.0.1/versions
  echo

  # Create Verdaccio config.
  # publish.allow_offline lets verdaccio accept publishes when the npmjs
  # uplink is briefly unreachable, instead of returning 503. We never want
  # the upstream existence check to gate these local fake-publishes.
  cat > /tmp/verdaccio-config.yaml <<EOF
storage: $PWD/verdaccio-storage
max_body_size: 1000mb

uplinks:
  npmjs:
    url: https://registry.npmjs.org/

publish:
  allow_offline: true

packages:
  # The fake-published workspace packages are @aztec-labs and resolve from storage;
  # @aztec-foundation (the foundation pins from yarn-project's resolutions) and @aztec (the viem
  # fork) fall through to npmjs via the @*/* rule below, and cache into storage for the offline
  # test image.
  "@aztec-labs/*":
    access: \$all
    publish: \$all
    unpublish: \$all
    proxy: npmjs

  "@aztec/*":
    access: \$all
    publish: \$all
    unpublish: \$all
    proxy: npmjs

  "@*/*":
    access: \$all
    publish: \$all
    unpublish: \$all
    proxy: npmjs

  "**":
    access: \$all
    publish: \$all
    unpublish: \$all
    proxy: npmjs

logs: { type: stdout, format: pretty, level: warn }
EOF
  echo 'testuser:$2y$05$R1tRwE1mM3iT1dJ8hG16fOCTq7tFhFJ0IWrZ1bMCGJ6W9unQF3H3K' > /tmp/htpasswd

  if ! command -v verdaccio &>/dev/null; then
    # Install to a local prefix to avoid requiring root for global npm install.
    npm i -g --prefix /tmp/verdaccio-pkg verdaccio
    export PATH="/tmp/verdaccio-pkg/bin:$PATH"
  fi

  local base_hash=$(cache_content_hash ^aztec-up/Dockerfile.base)
  if ! cache_download aztec-up-test-base-image-$base_hash.zst; then
    docker build -t aztecprotocol/aztec-up-test-base -f Dockerfile.base .
    docker save aztecprotocol/aztec-up-test-base:latest > aztec-up-test-base-image
    cache_upload aztec-up-test-base-image-$base_hash.zst aztec-up-test-base-image
  else
    docker load < aztec-up-test-base-image
  fi

  if ! cache_download_stream aztec-up-test-image-$hash.zst | docker load; then
    rm -rf verdaccio-storage
    # Seed the storage with the proxied npmjs packages from a previous run, keyed on yarn.lock.
    # The seed is captured from post-prime storage for this exact lockfile, so on a hit the prime
    # step below is redundant and skipped — the dominant cost of this build (~1-2 min of npm
    # resolving and extracting ~2000 packages). This freezes in-range transitive resolution between
    # lockfile changes, which also makes the test image deterministic. The seed contains no
    # fake-published workspace packages: those are stripped before upload below.
    local deps_hash=$(cache_content_hash ^yarn-project/yarn.lock)
    local seeded=0
    cache_download aztec-up-verdaccio-cache-$deps_hash.zst && seeded=1
    verdaccio --config /tmp/verdaccio-config.yaml --listen 4873 &>/dev/null &
    verdaccio_pid=$!
    trap 'kill $verdaccio_pid &>/dev/null || true' EXIT
    while ! nc -z localhost 4873 &>/dev/null; do sleep 1; done

    # Configure local npm registry.
    export npm_config_registry="http://localhost:4873"
    # Throwaway cache: on transient registry errors npm serves stale cached
    # localhost:4873 packuments from a previous run, which makes deploy_npm's
    # "already published" check skip packages that were never published.
    export npm_config_cache=$(mktemp -d)
    export npm_config_userconfig=$(mktemp)
    cat > "$npm_config_userconfig" <<'EOF'
max_body_size=1000mb
registry=http://localhost:4873/
//localhost:4873/:username=testuser
//localhost:4873/:_password=dGVzdHBhc3M=
//localhost:4873/:email=test@example.com
//localhost:4873/:always-auth=true
EOF

    # Deploy all npm packages to local registry.
    version=0.0.1
    # Scoped fake-publish: workspace-local @aztec-labs deps are co-published at $version, while
    # foundation deps (bb.js, wsdb, noir packages, ...) keep the versions pinned in
    # yarn-project's root resolutions and resolve through the npmjs uplink.
    export NPM_RELEASE_RESOLUTIONS="$(jq -c '.resolutions // {}' $root/yarn-project/package.json)"
    # TODO(AD): we have kludged a retry here. a local NPM install ought to be robust enough not to.
    echo "Deploying packages to local npm registry (version: $version)..."
    local t=$SECONDS
    $root/yarn-project/bootstrap.sh get_projects |
      DRY_RUN= parallel --tag --line-buffer --halt now,fail=1 "retry 'cd {} && dump_fail \"deploy_npm $version\" >/dev/null'"
    echo "Package deploy took $((SECONDS - t))s."

    # Prime the verdaccio cache by installing the packages we'll use in tests.
    # This fetches all transitive dependencies from npmjs and caches them locally.
    # Use --prefix to avoid modifying the host system's global npm packages.
    # --no-audit --no-fund: nothing gates on them and audit re-scans the whole ~2000-package tree.
    if [ "$seeded" -eq 1 ]; then
      echo "Skipping prime: storage was seeded from cache for this yarn.lock."
    else
      echo "Priming verdaccio cache with all dependencies..."
      t=$SECONDS
      retry "npm i -g --no-audit --no-fund --prefix /tmp/npm-prime @aztec-labs/aztec@$version @aztec-labs/cli-wallet@$version"
      rm -rf /tmp/npm-prime
      echo "Prime took $((SECONDS - t))s."
    fi

    t=$SECONDS
    docker build -t aztecprotocol/aztec-up-test .
    echo "Image build took $((SECONDS - t))s."

    # Stream the save straight into the compressed upload — no ~900MB intermediate file on disk.
    t=$SECONDS
    docker save aztecprotocol/aztec-up-test:latest | cache_upload_stream aztec-up-test-image-$hash.zst
    echo "Image save and upload took $((SECONDS - t))s."

    # The test image now contains the full storage, so the live copy is free to become the seed
    # for future runs: strip the fake-published workspace packages (stale fakes must never leak
    # into a later run's registry) and upload the proxied npmjs remainder. Strip by exact package
    # name — matching on the fake version would also delete real packages whose upstream version
    # happens to collide (e.g. concat-map@0.0.1). cache_upload skips existing keys, so this
    # uploads once per yarn.lock change.
    $root/yarn-project/bootstrap.sh get_projects | while read -r project; do
      rm -rf "verdaccio-storage/$(jq -r .name "$project/package.json")"
    done
    cache_upload aztec-up-verdaccio-cache-$deps_hash.zst verdaccio-storage
  fi
}

function test_cmds {
  for test in amm_flow bridge_and_claim basic_install counter_contract default_scaffold no_shadow_user_bins; do
    echo "$hash:TIMEOUT=15m aztec-up/scripts/run_test.sh $test"
  done
}

function test {
  echo_header "aztec-up test"
  test_cmds | filter_test_cmds | parallelize
}

function release {
  echo_header "aztec-up release"
  local version=${REF_NAME#v}
  # e.g. "nightly", or "latest" for bare releases
  local dist_tag=$(dist_tag)
  # e.g. "4" from v4.1.0-nightly.20260319
  local major=$(semver major $REF_NAME)

  # Upload each file in bin/0.0.1/, replacing VERSION= lines with the release version.
  for file in bin/0.0.1/*; do
    sed "s/^VERSION=.*/VERSION=$version/" "$file" | \
      do_or_dryrun aws s3 cp - "s3://install.aztec.network/$version/$(basename $file)"
  done

  # Update versioned alias (e.g. v4-nightly, v5-latest).
  do_or_dryrun aws s3 cp - "s3://install.aztec.network/aliases/v${major}-${dist_tag}" <<< "$version"

  # Bare alias (e.g. "nightly") should always resolve to the default major.
  if [ "$major" = "$DEFAULT_MAJOR_VERSION" ]; then
    do_or_dryrun aws s3 cp - "s3://install.aztec.network/aliases/$dist_tag" <<< "$version"
  fi
}

# This is not done by CI.
# It's a manual process, as updating the root installer and alias index requires careful consideration.
function release_root_installer {
    # Upload root installer assets: aztec-install (with VERSION defaulting to latest), aztec-up, and banner files.
    sed "s/^VERSION=\${VERSION:-.*}/VERSION=\${VERSION:-latest}/" bin/0.0.1/aztec-install | \
      do_or_dryrun aws s3 cp - "s3://install.aztec.network/aztec-install"
    do_or_dryrun aws s3 cp bin/0.0.1/aztec-up "s3://install.aztec.network/aztec-up"
    do_or_dryrun aws s3 cp bin/0.0.1/aztec-banner "s3://install.aztec.network/aztec-banner"
    do_or_dryrun aws s3 cp bin/0.0.1/aztec-banner-truecolor "s3://install.aztec.network/aztec-banner-truecolor"

    # Update alias list.
    do_or_dryrun aws s3 cp bin/aliases/index "s3://install.aztec.network/aliases/index"
}

case "$cmd" in
  "")
    build
    ;;
  *)
    default_cmd_handler "$@"
    ;;
esac
