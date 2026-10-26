#!/usr/bin/env bash
source $(git rev-parse --show-toplevel)/ci3/source_bootstrap

# Covers every committed input of deps_hash (the yarn-project hash spans all of yarn-project/), because the
# test image carries the CI lock: an image reused across a change to those inputs would hand
# release_preflight a lock that it rejects.
hash=$(hash_str \
  $(cache_content_hash ^aztec-up/ ^ci3/release_prep_package_json ^ci3/deploy_npm) \
  $(../yarn-project/bootstrap.sh hash))

# Bare aliases ("nightly", "latest") resolve to this major version.
DEFAULT_MAJOR_VERSION=${AZTEC_TOOLCHAIN_DEFAULT_MAJOR_VERSION:-6}

# Tool versions baked into the install artifacts (uploaded to S3 on release).
# The installer reads exactly these keys: noir (noirup), foundry (foundryup),
# node (nvm minimum version).
function versions {
  echo "noir: $("$root"/labs-aztec-toolchain/bootstrap.sh noir_version)"
  echo "foundry: $(anvil --version | head -n1 | sed -E 's/anvil Version: ([0-9.]+).*/\1/')"
  echo "node: $(node --version | cut -d 'v' -f 2)"
}

# Where release_preflight leaves the installer lock for release to upload.
release_lock=release-lock/packages.tar.gz

# Hash of the inputs that decide the installer's lock: the Yarn lock, the root resolutions (which become the
# lock's overrides), the generator, this script (publish_local, the registry config, the build version), the
# rules ci3/deploy_npm applies to the published manifests, and the workspace manifest fields that npm copies
# into a lock entry (arborist's pkgMetaKeys, plus the install scripts behind hasInstallScript). yarn.lock
# records neither engines, os/cpu, license, funding, scripts nor private (which decides what is published),
# and merges dependencies with devDependencies. The manifests are sorted by name so the glob order of the
# locale does not change the hash. The registry seed and the CI lock share this hash, so a cached lock is
# only reused with a seed holding its tarballs.
function deps_hash {
  hash_str \
    "$(cache_content_hash ^yarn-project/yarn.lock ^yarn-project/scripts/generate-aztec-up-package-lock.mjs ^yarn-project/scripts/aztec-up-workspaces.mjs ^aztec-up/bootstrap.sh ^ci3/release_prep_package_json ^ci3/deploy_npm)" \
    "$(jq -c '.resolutions // {}' "$root"/yarn-project/package.json)" \
    "$(jq -cs 'map({name, private, dependencies, peerDependencies, peerDependenciesMeta, optionalDependencies,
      bundleDependencies, bundledDependencies, acceptDependencies, bin, engines, os, cpu, license, funding,
      workspaces, installScripts: ((.scripts // {}) | {preinstall, install, postinstall})}) | sort_by(.name)' \
      "$root"/yarn-project/*/package.json)"
}

# Cache key of the proxied-npmjs registry seed, which start_local_registry downloads and build uploads.
function verdaccio_seed_key {
  echo "aztec-up-verdaccio-cache-$(deps_hash).zst"
}

# Starts a local verdaccio on :4873 seeded from the proxied-npmjs cache, and points npm at it for
# the rest of this shell.
function start_local_registry {
  # Create Verdaccio config.
  # publish.allow_offline lets verdaccio accept publishes when the npmjs
  # uplink is briefly unreachable, instead of returning 503. We never want
  # the upstream existence check to gate these local fake-publishes.
  cat > /tmp/verdaccio-config.yaml <<EOF
storage: $PWD/verdaccio-storage
max_body_size: 1000mb

auth:
  htpasswd:
    file: ./htpasswd

# JWT rather than the default legacy tokens, which re-run the htpasswd bcrypt check on every request
# that carries one, including every packument and tarball read.
security:
  api:
    jwt:
      sign:
        expiresIn: 1d

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

  local verdaccio_version=7.0.1
  export PATH="/tmp/verdaccio-pkg/bin:$PATH"
  if [ "$(verdaccio --version 2>/dev/null)" != "v$verdaccio_version" ]; then
    # Install to a local prefix to avoid requiring root for global npm install.
    npm i -g --prefix /tmp/verdaccio-pkg verdaccio@$verdaccio_version
  fi

  rm -rf verdaccio-storage
  # Registry storage is only a download cache; the release lock determines dependency versions.
  verdaccio_seeded=0
  cache_download "$(verdaccio_seed_key)" && verdaccio_seeded=1
  # Whatever already holds the port would answer the wait below and receive the publishes.
  if nc -z localhost 4873 &>/dev/null; then
    echo_stderr ":4873 is already in use; refusing to publish to an unknown registry."
    exit 1
  fi
  # The login below registers the user; a file left by an earlier run could hold another password.
  rm -f /tmp/htpasswd
  verdaccio --config /tmp/verdaccio-config.yaml --listen 4873 &>/dev/null &
  verdaccio_pid=$!
  trap 'kill $verdaccio_pid &>/dev/null || true' EXIT
  local deadline=$((SECONDS + 120))
  while ! nc -z localhost 4873 &>/dev/null; do
    if ! kill -0 $verdaccio_pid 2>/dev/null; then
      echo_stderr "verdaccio exited before listening on :4873."
      exit 1
    fi
    if ((SECONDS >= deadline)); then
      echo_stderr "verdaccio did not listen on :4873 within 120s."
      exit 1
    fi
    sleep 1
  done

  # Verdaccio accepts Basic credentials only on its login route and answers 401 to any other
  # request that carries them, so npm authenticates with the token the login returns.
  local token
  if ! token=$(curl -sSf -X PUT -H 'content-type: application/json' \
    -d '{"name":"testuser","password":"testpass"}' \
    http://localhost:4873/-/user/org.couchdb.user:testuser | jq -er .token); then
    echo_stderr "Could not log in to the local registry on :4873."
    exit 1
  fi

  # Configure local npm registry.
  export npm_config_registry="http://localhost:4873"
  # Throwaway cache: on transient registry errors npm serves stale cached
  # localhost:4873 packuments from a previous run, which makes deploy_npm's
  # "already published" check skip packages that were never published.
  export npm_config_cache=$(mktemp -d)
  export npm_config_userconfig=$(mktemp)
  # The scopes are pinned as well as the default registry: ci3/source_npm_auth writes
  # "@aztec-labs:registry" into the global config when a release targets a private registry, and
  # a scope registry outranks "registry", so without these publish_local's publishes would leave
  # for that registry instead of verdaccio. Same key in the user config, which npm ranks higher.
  cat > "$npm_config_userconfig" <<EOF
max_body_size=1000mb
registry=http://localhost:4873/
@aztec-labs:registry=http://localhost:4873/
@aztec-foundation:registry=http://localhost:4873/
//localhost:4873/:_authToken=$token
EOF
}

# Fake-publishes every workspace package to the local registry at the given version.
function publish_local {
  local version=$1
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

  local base_hash=$(cache_content_hash ^aztec-up/Dockerfile.base)
  if ! cache_download aztec-up-test-base-image-$base_hash.zst; then
    docker build -t aztecprotocol/aztec-up-test-base -f Dockerfile.base .
    docker save aztecprotocol/aztec-up-test-base:latest > aztec-up-test-base-image
    cache_upload aztec-up-test-base-image-$base_hash.zst aztec-up-test-base-image
  else
    docker load < aztec-up-test-base-image
  fi

  if ! cache_download_stream aztec-up-test-image-$hash.zst | docker load; then
    start_local_registry

    version=0.0.1
    publish_local $version

    # The lock omits the integrity of the fake-published packages, so a lock generated for the same
    # dependency inputs is still valid, and the seed for those inputs holds every tarball it installs.
    local lock_key="aztec-up-package-lock-$(deps_hash).zst"
    if [ "$verdaccio_seeded" -eq 1 ] && cache_download "$lock_key"; then
      echo "Reusing the installer lock generated for these dependencies."
    else
      echo "Generating and fetching the locked installer dependencies..."
      retry "node \"$root/yarn-project/scripts/generate-aztec-up-package-lock.mjs\" \"$root/yarn-project\" \"$version\" bin/0.0.1 \"$(deps_hash)\""
    fi

    local t=$SECONDS
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
    # uploads once per change to the dependency inputs.
    $root/yarn-project/bootstrap.sh get_projects | while read -r project; do
      rm -rf "verdaccio-storage/$(jq -r .name "$project/package.json")"
    done
    cache_upload "$(verdaccio_seed_key)" verdaccio-storage
    # After the seed, so a cached lock always has a seed to pair with.
    cache_upload "$lock_key" bin/0.0.1/packages.tar.gz
  else
    # The lock travels inside the image so a cache hit never pairs it with another run's registry.
    docker run --rm aztecprotocol/aztec-up-test cat /home/ubuntu/packages.tar.gz > bin/0.0.1/packages.tar.gz
  fi
}

function test_cmds {
  echo "$hash node --test yarn-project/scripts/aztec-up-release-lock.test.mjs"
  for test in amm_flow bridge_and_claim basic_install counter_contract default_scaffold no_shadow_user_bins; do
    echo "$hash:TIMEOUT=15m aztec-up/scripts/run_test.sh $test"
  done
}

function test {
  echo_header "aztec-up test"
  test_cmds | filter_test_cmds | parallelize
}

# Rewrites the lock built and checked during CI to the release version without resolving packages.
# The archive carries its dependency-input hash so a direct release rejects an older build.
function release_preflight {
  echo_header "aztec-up release preflight"
  local version=${REF_NAME#v}
  local build_lock=bin/0.0.1/packages.tar.gz
  if [ ! -f "$build_lock" ]; then
    echo_stderr "No installer build lock at aztec-up/$build_lock. Build aztec-up first."
    exit 1
  fi
  rm -rf "$(dirname "$release_lock")"
  node "$root/yarn-project/scripts/aztec-up-release-lock.mjs" \
    "$root/yarn-project" "$build_lock" "$version" "$(deps_hash)" "$(dirname "$release_lock")"
}

function release {
  echo_header "aztec-up release"
  local version=${REF_NAME#v}
  # e.g. "nightly", or "latest" for bare releases
  local dist_tag=$(dist_tag)
  # e.g. "4" from v4.1.0-nightly.20260319
  local major=$(semver major $REF_NAME)

  if [ ! -f "$release_lock" ]; then
    echo_stderr "No installer lock at aztec-up/$release_lock. Run release_preflight first."
    exit 1
  fi
  local lock_version
  lock_version=$(tar -xzOf "$release_lock" package.json | jq -r .version)
  if [ "$lock_version" != "$version" ]; then
    echo_stderr "aztec-up/$release_lock is for $lock_version, not $version. Run release_preflight again."
    exit 1
  fi
  do_or_dryrun aws s3 cp "$release_lock" "s3://install.aztec.network/$version/packages.tar.gz"

  # Upload each file in bin/0.0.1/, replacing VERSION= lines with the release version.
  for file in bin/0.0.1/*; do
    [[ "$file" == *.tar.gz ]] && continue
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
