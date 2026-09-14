#!/usr/bin/env bash
# Wait until <name>@<version> is resolvable from the npm registry - npm's missing
# `publish --wait` (cargo has one). A publish returns before installers can see the
# version, and the main package's exact pins on the platform packages mean publishing it
# too early lets npm silently skip them. Fresh cache each poll: npm answers packument
# requests from its own cache for the registry's max-age=300 without asking again.
set -euo pipefail

name=$1
version=$2
attempts=${NPM_WAIT_ATTEMPTS:-40}
interval=${NPM_WAIT_INTERVAL:-15}
cache=./.npm-wait-cache
trap 'rm -rf "$cache"' EXIT

for ((i = 1; i <= attempts; i++)); do
    rm -rf "$cache"
    if [[ "$(npm view --cache "$cache" "$name@$version" version 2>/dev/null)" == "$version" ]]; then
        echo "$name@$version resolvable"
        exit 0
    fi
    echo "$name@$version not resolvable yet ($i/$attempts)"
    sleep "$interval"
done

echo "::error::$name@$version not resolvable after $((attempts * interval))s"
exit 1
