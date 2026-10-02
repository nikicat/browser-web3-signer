#!/usr/bin/env bash
# Cut a release: `just release [major|minor|patch|X.Y.Z]` (default: minor).
#
# Run from a clean, up-to-date main, or from a release/* branch for a maintenance release.
# Bumps the lockstep version (Cargo.toml [workspace.package] + the internal dep pins in
# [workspace.dependencies] + ts/package.json + Cargo.lock), commits it to the current
# branch, tags the commit vX.Y.Z, and pushes branch and tag together.
#
# The tag push IS the release: the Release workflow (release.yml) checks the tag against
# the versions and the branch, runs CI, builds the binaries, creates the GitHub release,
# pushes the go/vX.Y.Z tag, and publishes the npm packages and crates.io crates.
# DRY_RUN=1 stops before pushing anything.
set -euo pipefail

cd "$(dirname "$0")/.."

level="${1:-minor}"

branch="$(git rev-parse --abbrev-ref HEAD)"
# The branches release.yml's preflight accepts; keep the two lists equal.
[[ "$branch" == "main" || "$branch" == release/* ]] || { echo "run from main or a release/* branch"; exit 1; }
git diff --quiet HEAD || { echo "dirty tree"; exit 1; }
git pull --ff-only --quiet

current=$(sed -n '/^\[workspace\.package\]/,/^\[/p' Cargo.toml | sed -n 's/^version = "\(.*\)"/\1/p' | head -1)
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
tag="v$version"
git ls-remote --exit-code --tags origin "refs/tags/$tag" > /dev/null && { echo "$tag already exists on origin"; exit 1; }

echo "releasing $current → $version from $branch"
# /g also bumps the `version` on the internal path deps in [workspace.dependencies],
# which must stay in lockstep for crates.io publishing (preflight enforces this).
sed -i "s/version = \"$current\"/version = \"$version\"/g" Cargo.toml
sed -i "s/\"version\": \"$current\"/\"version\": \"$version\"/" ts/package.json
cargo update --workspace --quiet
git commit --quiet -am "Bump version to $version"
git tag -a "$tag" -m "$tag"

if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "DRY_RUN: stopping before push; bump commit and $tag left on $branch"
    echo "(undo: git tag -d $tag && git reset --hard HEAD~1)"
    exit 0
fi

# Atomic: the tag never reaches origin without the commit on its branch, which preflight checks.
git push --atomic origin "HEAD:refs/heads/$branch" "refs/tags/$tag"
echo "pushed $tag — the Release workflow is running:"
echo "  gh run list --workflow release.yml --limit 1"
