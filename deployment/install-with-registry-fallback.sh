#!/bin/sh
# Used only while building application images; keep versions and integrity checks intact.
set -eu

primary="${NPM_REGISTRY:-https://registry.npmjs.org}"
fallback="${NPM_FALLBACK_REGISTRY-https://registry.npmmirror.com}"

install_from() {
  registry="$1"
  shift
  "$@" --registry="$registry" --fetch-timeout=180000 --fetch-retries=1 \
    --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=30000
}

if install_from "$primary" "$@"; then
  exit 0
else
  status=$?
fi

if [ -z "$fallback" ] || [ "$fallback" = "$primary" ]; then
  exit "$status"
fi

echo 'Dependency installation failed with the primary registry; retrying with the fallback and existing download cache.' >&2
install_from "$fallback" "$@"
