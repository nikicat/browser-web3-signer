#!/usr/bin/env bash
#
# Fetch the Leather browser extension, in its test mode, for the real-wallet Bitcoin e2e
# (tests/e2e-browser/btc-leather). Leather publishes no built artifacts, so this downloads a CRX
# released from our fork, github.com/nikicat/leather-mono: the upstream release tag, built in
# test mode with the fork's fixes on top (branch bw3s/extension-<version>). It unpacks to
# target/leather/dist; a dist unpacked from the same release is reused.
#
# Fork fixes:
#   - restore the wallet session only after the store rehydrates (else a popup can come up locked)
#
# To bump: rebase the fork branch onto the new upstream tag, build it the way Leather's CI does
# (`WALLET_ENVIRONMENT=testing pnpm build:test`), pack dist into a CRX, release it on the fork,
# and update the pins below together with tests/e2e-browser/btc-leather/fixtures/leather-state.mts.
#
# Usage:  scripts/fetch-leather.sh

set -euo pipefail

readonly RELEASE="extension-v6.115.0-bw3s.1"
readonly CRX="leather-6.115.0-bw3s.1-test.crx"
readonly CRX_SHA256="f046371ce74037754f5922210ca63b70ceceaf3ca4bf8891290505509edfe905"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly OUT="$ROOT_DIR/target/leather"
readonly STAMP="$OUT/dist/.bw3s-fetched-from"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$RELEASE" ]; then
  echo "Leather $RELEASE already in $OUT/dist"
  exit 0
fi

mkdir -p "$OUT"
curl -sSfL -o "$OUT/$CRX" "https://github.com/nikicat/leather-mono/releases/download/$RELEASE/$CRX"
echo "$CRX_SHA256  $OUT/$CRX" | sha256sum -c -
rm -rf "$OUT/dist"
# A CRX is a zip behind a signature header; unzip skips the header and exits 1 to say so.
unzip -qq "$OUT/$CRX" -d "$OUT/dist" || [ $? -eq 1 ]
echo "$RELEASE" > "$STAMP"
echo "Fetched Leather $RELEASE: $OUT/dist"
