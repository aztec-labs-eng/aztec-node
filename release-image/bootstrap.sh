#!/usr/bin/env bash
source $(git rev-parse --show-toplevel)/ci3/source_bootstrap

hash=$(cache_content_hash ^release-image/Dockerfile ^release-image/Dockerfile.base.dockerignore ^release-image/Dockerfile.dockerignore ^build-images/src/Dockerfile ^labs-aztec-toolchain/bootstrap.sh ^yarn-project/yarn.lock)

function prepare_crs {
  echo_header "prepare crs for prover-agent image"
  local crs_src=${CRS_PATH:-$HOME/.bb-crs}

  if [ ! -f "$crs_src/bn254_g1_compressed.dat" ] || [ ! -f "$crs_src/grumpkin_g1_v2.flat.dat" ]; then
    # this assumes we pull the required number of points for proving the biggest circuit
    echo "CRS not found at $crs_src, downloading..."
    $root/release-image/download_bb_crs.sh
    crs_src=$HOME/.bb-crs
  fi

  mkdir -p crs
  cp "$crs_src/bn254_g1_compressed.dat" crs/
  cp "$crs_src/bn254_g2.dat" crs/
  cp "$crs_src/grumpkin_g1_v2.flat.dat" crs/
  # Normalize timestamps so COPY --link produces an identical layer across builds
  for f in crs/*; do touch -t 197001010000 "$f"; done
  echo "CRS files staged in crs/ ($(du -sh crs | cut -f1))"
}
export -f prepare_crs

function build_prover_agent_image {
  set -euo pipefail
  local tag=$(git rev-parse HEAD)

  if ! docker image inspect azteclabs/aztec:$tag &>/dev/null; then
    echo "Base image azteclabs/aztec:$tag not found. Run 'release-image/bootstrap.sh' first."
    exit 1
  fi

  prepare_crs
  echo_header "build prover-agent image"
  docker build -f Dockerfile.prover-agent --build-arg AZTEC_IMAGE_TAG=$tag \
    -t azteclabs/aztec-prover-agent:$tag .
  docker tag azteclabs/aztec-prover-agent:$tag azteclabs/aztec-prover-agent:latest
}
export -f build_prover_agent_image

# The image runs these two, so a missing one fails the build rather than the container. Symlinks
# are rejected too, since docker copies the link and not its target: even one that resolves here
# would dangle in the image (build_monorepo provisions bin/ as symlinks).
function check_toolchain_binaries {
  local binary path
  for binary in bb-avm noir-execute; do
    path=$root/labs-aztec-toolchain/bin/$binary
    if [ -L "$path" ]; then
      echo "labs-aztec-toolchain/bin/$binary is a symlink and would dangle in the image. Run labs-aztec-toolchain/bootstrap.sh first."
      exit 1
    fi
    if [ ! -f "$path" ]; then
      echo "Missing labs-aztec-toolchain/bin/$binary. Run labs-aztec-toolchain/bootstrap.sh first."
      if [ "$binary" = noir-execute ]; then
        echo "Building noir-execute requires cargo to be installed."
      fi
      exit 1
    fi
  done
}
export -f check_toolchain_binaries

function build_image {
  set -euo pipefail
  cd ..
  check_toolchain_binaries
  if semver check $REF_NAME; then
    # We are a tagged release. Use the version from the tag.
    # We strip leading 'v' so that this is a valid semver.
    local version=${REF_NAME#v}
  else
    # Otherwise, use the commit hash as the version.
    local version=$(git rev-parse HEAD)
  fi
  local previous_ids=$(docker images azteclabs/aztec --format "{{.ID}}" | uniq)
  docker build -f release-image/Dockerfile --build-arg VERSION=$version -t azteclabs/aztec:$(git rev-parse HEAD) .
  docker tag azteclabs/aztec:$(git rev-parse HEAD) azteclabs/aztec:latest

  # In CI, dump all files under /usr/src.
  if [ "$CI" -eq 1 ]; then
    docker run --rm --entrypoint /bin/bash azteclabs/aztec:latest -c 'cd /usr/src && find . -print | grep -v node_modules'
  fi

  # If we actually built a new image (not from cache), remove all but the just-built image.
  local new_ids=$(docker images azteclabs/aztec --format "{{.ID}}" | uniq)
  if [ "$previous_ids" != "$new_ids" ]; then
    echo "$previous_ids" | xargs -r docker rmi -f
  fi
}
export -f build_image

function build {
  echo_header "release-image build"

  if ! command -v docker &>/dev/null; then
    echo "Docker is required to build the release image. Skipping."
    exit 0
  fi

  if ! cache_download release-image-base-$hash.zst; then
    denoise "cd .. && docker build -f release-image/Dockerfile.base -t aztecprotocol/release-image-base ."
    docker save aztecprotocol/release-image-base:latest > release-image-base
    cache_upload release-image-base-$hash.zst release-image-base
  else
    docker load < release-image-base
  fi

  denoise "build_image"

  if semver check "${REF_NAME:-}"; then
    denoise "build_prover_agent_image"
  fi
}

function test_cmds {
  if ! command -v docker &>/dev/null; then
    exit 0
  fi

  # Very simple sanity test.
  echo "$hash docker run --rm azteclabs/aztec --version"
}

# Resolve the registry to release to and log docker into it, assigning the repo path to the
# caller's $repo. In a private release we push to our internal GCP Artifact Registry (the
# INTERNAL_DOCKER_REGISTRY that GKE/staging pulls from) rather than Docker Hub. Auth via the CI
# service-account key (gcp_artifact_login). INTERNAL_DOCKER_REGISTRY is the AR repo path, e.g.
# us-west1-docker.pkg.dev/<project>/<repo>.
function release_registry_login {
  if [ "${PRIVATE_RELEASE:-0}" = 1 ]; then
    : "${INTERNAL_DOCKER_REGISTRY:?INTERNAL_DOCKER_REGISTRY required for a private release}"
    gcp_artifact_login
    repo="${INTERNAL_DOCKER_REGISTRY%/}"
  else
    if [ -z "${DOCKERHUB_PASSWORD:-}" ]; then
      echo "Missing DOCKERHUB_PASSWORD."
      exit 1
    fi
    echo $DOCKERHUB_PASSWORD | docker login -u ${DOCKERHUB_USERNAME:-aztecprotocolci} --password-stdin
    repo="azteclabs"
  fi
}

function release {
  echo_header "release-image release"

  local repo
  release_registry_login

  # We strip leading 'v' so that this is a valid semver.
  tag=${REF_NAME#v}
  docker tag azteclabs/aztec:$COMMIT_HASH $repo/aztec:$tag-$(arch)
  do_or_dryrun docker push $repo/aztec:$tag-$(arch)

  docker tag azteclabs/aztec-prover-agent:$COMMIT_HASH $repo/aztec-prover-agent:$tag-$(arch)
  do_or_dryrun docker push $repo/aztec-prover-agent:$tag-$(arch)
}

# Assemble the multi-arch manifest lists (e.g. aztec:1.0.0 from aztec:1.0.0-amd64 and
# aztec:1.0.0-arm64). Run from the release orchestrator (ci.sh release) after both arch jobs
# have pushed their images; imagetools only talks to the registry, so no local images are needed.
function release_docker_manifest {
  echo_header "release-image manifest"

  local repo
  release_registry_login

  local tag=${REF_NAME#v}
  local image
  for image in aztec aztec-prover-agent; do
    do_or_dryrun docker buildx imagetools create -t $repo/$image:$tag \
      $repo/$image:$tag-amd64 \
      $repo/$image:$tag-arm64
  done

  # We also release with our dist_tag, e.g. 'latest', 'staging' or 'nightly'.
  # docker buildx imagetools create -t $repo/aztec:$(dist_tag) \
  #   $repo/aztec:$tag-amd64 \
  #   $repo/aztec:$tag-arm64
}

function push {
  echo_header "release-image push"

  if [ -z "${DOCKERHUB_PASSWORD:-}" ]; then
    echo "Missing DOCKERHUB_PASSWORD."
    exit 1
  fi
  echo $DOCKERHUB_PASSWORD | docker login -u ${DOCKERHUB_USERNAME:-aztecprotocolci} --password-stdin
  do_or_dryrun docker push azteclabs/aztec:$COMMIT_HASH
  do_or_dryrun docker push azteclabs/aztec-prover-agent:$COMMIT_HASH
}

# Publish the just-built image so a Kubernetes cluster can pull it. The network deploy and bench
# jobs run against real GKE namespaces, which cannot use an image that only exists in the local
# docker daemon, so an unreleased commit needs to reach a registry before it can be deployed.
#
# These go to aztec-dev rather than aztec: the tags are per-commit build artifacts with no
# lifecycle, and mixing thousands of them into the repo operators pull from would bury the
# released versions. Nothing outside CI is expected to pull aztec-dev, and its tags may be
# pruned at any time.
#
# Only the node image is pushed. Deployments leave PROVER_AGENT_DOCKER_IMAGE unset, so the prover
# agents run this same image; the dedicated prover-agent image only exists to bake in the CRS, and
# is only built for tagged releases anyway.
function push_pr {
  echo_header "release-image push_pr"

  if [ -z "${DOCKERHUB_PASSWORD:-}" ]; then
    echo "Missing DOCKERHUB_PASSWORD."
    exit 1
  fi
  echo $DOCKERHUB_PASSWORD | docker login -u ${DOCKERHUB_USERNAME:-aztecprotocolci} --password-stdin
  docker tag azteclabs/aztec:$COMMIT_HASH azteclabs/aztec-dev:$COMMIT_HASH
  do_or_dryrun docker push azteclabs/aztec-dev:$COMMIT_HASH
}

case "$cmd" in
  "")
    build
    ;;
  *)
    default_cmd_handler "$@"
    ;;
esac
