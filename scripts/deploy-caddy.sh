#!/usr/bin/env bash
# Update selected application images without unbounded production builds.
set -euo pipefail
services=("$@")
if [[ ${#services[@]} -eq 0 ]]; then
  services=(web client-web)
fi
for service in "${services[@]}"; do
  case "$service" in
    web|client-web) ;;
    *)
      echo "Unsupported service: $service. Usage: bash scripts/deploy-caddy.sh [web] [client-web]" >&2
      exit 2
      ;;
  esac
done
cd "$(dirname "$0")/.."
builder=proctor-limited
compose_files=(-f docker-compose.caddy.yml)
# Each host may supply private DNS/CA settings without changing shared config.
if [[ -f deployment/docker-compose.host.yml ]]; then
  compose_files+=(-f deployment/docker-compose.host.yml)
fi
compose=(docker compose "${compose_files[@]}")
"${compose[@]}" config --quiet

# The moving `buildx-stable-1` builder image now ships a runc that this class of
# host kernel rejects when BuildKit masks /proc ("can't mask dir /proc/acpi"), so
# the bounded builder pins a BuildKit release whose runtime still works here.
# Override with PROCTOR_BUILDKIT_IMAGE on hosts that need a different one.
builder_image=${PROCTOR_BUILDKIT_IMAGE:-moby/buildkit:v0.12.5}

create_bounded_builder() {
  # buildx renamed this flag; older releases (e.g. 0.10.x) only accept --config.
  local config_flag=--buildkitd-config
  if ! docker buildx create --help 2>&1 | grep -q -- '--buildkitd-config'; then
    config_flag=--config
  fi
  local limits=memory=2048m,memory-swap=2048m,cpu-period=100000,cpu-quota=200000
  if ! docker buildx create --name "$builder" --driver docker-container "$config_flag" deployment/buildkitd.toml \
      --driver-opt "image=$builder_image,$limits,default-load=true,restart-policy=no" 2>/dev/null; then
    # Older buildx releases reject resource limits as driver options; the limits
    # are applied to the builder container after bootstrap instead.
    docker buildx rm "$builder" >/dev/null 2>&1 || true
    docker buildx create --name "$builder" --driver docker-container "$config_flag" deployment/buildkitd.toml \
      --driver-opt "image=$builder_image"
  fi
}

prepare_bounded_builder() {
  if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
    create_bounded_builder || return 1
  fi
  # Bootstrapping can report a transient socket timeout while BuildKit starts.
  local attempt bootstrapped=0
  for attempt in 1 2 3; do
    if docker buildx inspect "$builder" --bootstrap >/dev/null 2>&1; then
      bootstrapped=1
      break
    fi
    sleep 5
  done
  if (( bootstrapped != 1 )); then
    echo "The resource-limited builder could not start." >&2
    return 1
  fi
  container="buildx_buildkit_${builder}0"
  for attempt in 1 2 3 4 5; do
    # Bound the build even when buildx could not set the limits itself.
    docker update --memory 2147483648 --memory-swap 2147483648 --cpu-period 100000 --cpu-quota 200000 \
      "$container" >/dev/null 2>&1 && break
    sleep 3
  done
  local memory swap quota period
  memory=$(docker inspect "$container" --format '{{.HostConfig.Memory}}' 2>/dev/null || echo unknown)
  swap=$(docker inspect "$container" --format '{{.HostConfig.MemorySwap}}' 2>/dev/null || echo unknown)
  quota=$(docker inspect "$container" --format '{{.HostConfig.CpuQuota}}' 2>/dev/null || echo unknown)
  period=$(docker inspect "$container" --format '{{.HostConfig.CpuPeriod}}' 2>/dev/null || echo unknown)
  if [[ "$memory" != 2147483648 || "$swap" != 2147483648 || "$quota" != 200000 || "$period" != 100000 ]]; then
    echo "Build resource limits do not match the expected 2048 MiB / 2 CPU configuration." >&2
    return 1
  fi
  # The probe must actually RUN a command: a metadata-only build never starts a
  # container, so it would not catch an unusable builder runtime.
  local probe usable=0
  probe=$(mktemp -d)
  printf 'FROM busybox:1.37.0\nRUN true\n' > "$probe/Dockerfile"
  if docker buildx build --builder "$builder" --load -t proctor-builder-probe "$probe" >/dev/null 2>&1; then
    usable=1
  fi
  rm -rf "$probe"
  (( usable == 1 ))
}

trap 'docker buildx stop "$builder" >/dev/null 2>&1 || true' EXIT
if ! prepare_bounded_builder; then
  echo "Deployment stopped: the resource-limited builder is unavailable. Fix the builder before retrying; running services were not restarted." >&2
  exit 1
fi

# `docker compose build` cannot select a builder before Compose 2.20, and it can
# hang outright with a docker-container builder, so images are built through
# `buildx bake`, which reads the same Compose file and resolves the same args.
# bake does not name images for Compose services that omit `image:`, so the
# Compose image name is set explicitly, otherwise `up` would try to pull it.
project=${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}
# One image at a time; failed/OOM builds leave the running images intact.
for service in "${services[@]}"; do
  bake=(docker buildx bake --builder "$builder" --load "${compose_files[@]}" \
    --set "${service}.tags=${project}-${service}")
  "${bake[@]}" "$service"
done
"${compose[@]}" up -d --no-deps --no-build "${services[@]}"
"${compose[@]}" ps
