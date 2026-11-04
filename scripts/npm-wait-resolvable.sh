#!/usr/bin/env bash
# Wait until <name>@<version> is resolvable from the npm registry - npm's missing
# `publish --wait` (cargo has one). A publish returns before installers can see the
# version, and the main package's exact pins on the platform packages mean publishing it
# too early lets npm silently skip them.
#
# The registry's CDN caches a package's metadata for up to 5 minutes (max-age=300), so a
# request made too early caches a copy without the new version. The first loop therefore asks
# with a unique query string, which the CDN does not serve from or store in its cache; only
# once the registry has the version does the second loop ask the way installers do.
set -euo pipefail

name=$1
version=$2
attempts=${NPM_WAIT_ATTEMPTS:-40}
interval=${NPM_WAIT_INTERVAL:-15}
cache=./.npm-wait-cache
trap 'rm -rf "$cache"' EXIT
url="https://registry.npmjs.org/${name/\//%2f}"

wait_for() {
    local what=$1 check=$2 i
    for ((i = 1; i <= attempts; i++)); do
        if "$check"; then
            echo "$name@$version $what after ${SECONDS}s"
            return 0
        fi
        echo "$name@$version not $what yet ($i/$attempts)"
        sleep "$interval"
    done
    echo "::error::$name@$version not $what after $((attempts * interval))s"
    exit 1
}

# The registry itself, past the CDN cache.
on_registry() {
    curl -fsS -H 'Accept: application/vnd.npm.install-v1+json' "$url?t=$(date +%s%N)" 2>/dev/null \
        | jq -e --arg v "$version" '.versions[$v]' > /dev/null
}

# What installers see. A fresh npm cache each poll, since npm answers from its own cache too.
resolvable() {
    rm -rf "$cache"
    [[ "$(npm view --cache "$cache" "$name@$version" version 2>/dev/null)" == "$version" ]]
}

wait_for "on the registry" on_registry
wait_for resolvable resolvable
