#!/usr/bin/env bash
# Publish a package directory unless that version is already on npm, so a re-run release
# skips what an earlier attempt published: `npm-publish-once.sh <name>@<version> <dir>`.
#
# It does not ask the registry first. An `npm view` right before publishing makes npm's CDN
# cache the package's metadata without the new version for up to 5 minutes, which is what
# npm-wait-resolvable.sh then has to wait out. npm's own refusal to overwrite a version is the
# check instead.
set -euo pipefail

spec=$1
dir=$2

if out=$(npm publish --access public "$dir" 2>&1); then
    echo "$out"
elif grep -qi 'cannot publish over the previously published version' <<<"$out"; then
    echo "$spec already published, skipping"
else
    echo "$out" >&2
    exit 1
fi
