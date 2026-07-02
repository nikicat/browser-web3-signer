#!/usr/bin/env bash
# Cut a release in one command: `just release [major|minor|patch|X.Y.Z]` (default: minor).
#
# From a clean, up-to-date master this bumps the lockstep version (Cargo.toml
# [workspace.package] + ts/package.json + Cargo.lock), commits and pushes the bump, waits
# for CI to pass on it, then pushes the two tags:
#   - vX.Y.Z     → triggers the Release workflow (binaries + npm via OIDC)
#   - go/vX.Y.Z  → versions the Go module in go/ (subdirectory modules need their own
#                  prefixed tag; it cannot match the Release workflow's tag pattern)
#
# The Release workflow's preflight re-checks the version lockstep, so a mismatch fails
# loudly before anything is published. DRY_RUN=1 stops before pushing anything.
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
sed -i "s/^version = \"$current\"/version = \"$version\"/" Cargo.toml
sed -i "s/\"version\": \"$current\"/\"version\": \"$version\"/" ts/package.json
cargo update --workspace --quiet
git commit --quiet -am "Bump version to $version"

if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "DRY_RUN: stopping before push; bump commit left on master (undo: git reset --hard @{u})"
    exit 0
fi

git push origin master
sha=$(git rev-parse HEAD)

echo "waiting for CI on $sha…"
run_id=""
for _ in $(seq 30); do
    run_id=$(gh run list --commit "$sha" --workflow ci.yml --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
    [[ -n "$run_id" ]] && break
    sleep 5
done
[[ -n "$run_id" ]] || { echo "CI run for $sha never appeared"; exit 1; }
gh run watch "$run_id" --exit-status > /dev/null || { echo "CI failed — fix master, then re-run; no tags were pushed"; exit 1; }

git tag "v$version"
git tag "go/v$version"
git push origin "v$version" "go/v$version"
echo "v$version tagged — Release workflow: $(gh run list --workflow release.yml --limit 1 --json url --jq '.[0].url' 2>/dev/null || echo 'gh run list --workflow release.yml')"
