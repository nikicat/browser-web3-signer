#!/usr/bin/env bash
# Cut a release: `just release [major|minor|patch|X.Y.Z]` (default: minor).
#
# From a clean, up-to-date master this bumps the lockstep version (Cargo.toml
# [workspace.package] + the internal dep pins in [workspace.dependencies] +
# ts/package.json + Cargo.lock) on a release/vX.Y.Z branch, pushes it, and opens a PR.
#
# Merging that PR IS the release: the Release workflow (release.yml) sees the version
# bump land on master, creates the vX.Y.Z GitHub release on the merge commit (binaries +
# SHA256SUMS), pushes the go/vX.Y.Z tag that versions the Go module, and publishes the
# npm packages and crates.io crates. DRY_RUN=1 stops before pushing anything.
set -euo pipefail

cd "$(dirname "$0")/.."

level="${1:-minor}"

[[ "$(git rev-parse --abbrev-ref HEAD)" == "master" ]] || { echo "run from master"; exit 1; }
git diff --quiet HEAD || { echo "dirty tree"; exit 1; }
git pull --ff-only --quiet

current=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
[[ -n "$current" ]] || { echo "cannot read version from Cargo.toml"; exit 1; }

if [[ "$level" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    version="$level"
else
    IFS=. read -r maj min pat <<<"$current"
    case "$level" in
        major) version="$((maj + 1)).0.0" ;;
        minor) version="$maj.$((min + 1)).0" ;;
        patch) version="$maj.$min.$((pat + 1))" ;;
        *) echo "usage: release.sh [major|minor|patch|X.Y.Z]"; exit 1 ;;
    esac
fi

echo "releasing $current → $version"
git checkout -q -b "release/v$version"
# /g also bumps the `version` on the internal path deps in [workspace.dependencies],
# which must stay in lockstep for crates.io publishing (preflight enforces this).
sed -i "s/version = \"$current\"/version = \"$version\"/g" Cargo.toml
sed -i "s/\"version\": \"$current\"/\"version\": \"$version\"/" ts/package.json
cargo update --workspace --quiet
git commit --quiet -am "Bump version to $version"

if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "DRY_RUN: stopping before push; bump commit left on release/v$version"
    echo "(undo: git checkout master && git branch -D release/v$version)"
    exit 0
fi

git push -u origin "release/v$version"
pr_url=$(gh pr create \
    --title "Bump version to $version" \
    --body "Merging this PR releases v$version: the Release workflow tags the merge commit, uploads binaries to the GitHub release, and publishes the npm packages and crates.io crates.")
git checkout -q master

echo "release PR: $pr_url"
echo "merge it (merge commit, not squash) once CI is green — the merge triggers the release."
