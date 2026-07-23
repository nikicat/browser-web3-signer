#!/usr/bin/env bash
# Download and unpack the pinned Ambire release build (webkit = Chromium family).
set -euo pipefail
cd "$(dirname "$0")"

VERSION=v6.15.3
ZIP="ambire-extension-${VERSION}-webkit.zip"

if [ -d ambire-build ]; then
  echo "ambire-build/ already present — remove it to re-download"
  exit 0
fi

gh release download "$VERSION" --repo AmbireTech/extension -p "$ZIP"
mkdir ambire-build
unzip -q "$ZIP" -d ambire-build
rm "$ZIP"
echo "Ambire $VERSION unpacked into ambire-build/"
