#!/usr/bin/env bash
#
# Build the Leather browser extension, in its test mode, for the real-wallet Bitcoin e2e
# (tests/e2e-browser/btc-leather). Leather publishes no built artifacts, so this checks out the
# pinned release tag of leather-io/mono and runs the same steps as Leather's own CI
# (.github/workflows/extension:integration-tests.yml). The result is
# $LEATHER_SRC/apps/extension/dist; a dist built from the same tag is reused.
#
# Usage:  scripts/build-leather.sh
#         LEATHER_SRC=/some/dir scripts/build-leather.sh   # build somewhere else (default target/leather)

set -euo pipefail

# Bump together with the wallet state in tests/e2e-browser/btc-leather/fixtures/leather-state.mts.
readonly LEATHER_VERSION="6.115.0"
readonly TAG="@leather.io/extension-v${LEATHER_VERSION}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SRC="${LEATHER_SRC:-$ROOT_DIR/target/leather}"
readonly STAMP="$SRC/apps/extension/dist/.bw3s-built-from"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$TAG" ]; then
  echo "Leather $LEATHER_VERSION already built in $SRC/apps/extension/dist"
  exit 0
fi

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$TAG" https://github.com/leather-io/mono "$SRC"
else
  git -C "$SRC" fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
  git -C "$SRC" checkout --force "$TAG"
fi

cd "$SRC"
pnpm install --frozen-lockfile --ignore-scripts
pnpm turbo run build --filter=@leather.io/panda-preset
pnpm turbo build --filter='@leather.io/extension^...'
cd apps/extension
pnpm run prepare:build
WALLET_ENVIRONMENT=testing pnpm build:test
echo "$TAG" > "$STAMP"
echo "Built Leather $LEATHER_VERSION: $SRC/apps/extension/dist"
