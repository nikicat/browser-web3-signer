/**
 * Unit tests for the platform → npm-platform-package mapping. Hermetic: no Rust binary,
 * no network — the integration suite (wallet-signer.test.ts) covers actual spawning.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { platformPackage, resolvePlatformBinary, supportedPlatforms } from "../src/platform.ts";

test("maps the five supported platforms to their packages", () => {
  assert.deepEqual(platformPackage("linux", "x64"), {
    pkg: "@nikicat/browser-web3-signer-linux-x64",
    exe: "browser-web3-signer",
  });
  assert.deepEqual(platformPackage("linux", "arm64"), {
    pkg: "@nikicat/browser-web3-signer-linux-arm64",
    exe: "browser-web3-signer",
  });
  assert.deepEqual(platformPackage("darwin", "x64"), {
    pkg: "@nikicat/browser-web3-signer-darwin-x64",
    exe: "browser-web3-signer",
  });
  assert.deepEqual(platformPackage("darwin", "arm64"), {
    pkg: "@nikicat/browser-web3-signer-darwin-arm64",
    exe: "browser-web3-signer",
  });
  assert.deepEqual(platformPackage("win32", "x64"), {
    pkg: "@nikicat/browser-web3-signer-win32-x64",
    exe: "browser-web3-signer.exe",
  });
});

test("returns null for unsupported platforms", () => {
  assert.equal(platformPackage("freebsd", "x64"), null);
  assert.equal(platformPackage("win32", "arm64"), null);
  assert.equal(platformPackage("linux", "ia32"), null);
});

test("supportedPlatforms lists all five pairs", () => {
  const listed = supportedPlatforms();
  for (const pair of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
    assert.ok(listed.includes(pair), `missing ${pair} in "${listed}"`);
  }
});

test("resolvePlatformBinary returns null when the package is not installed", () => {
  // In the dev checkout the platform packages are never installed (they are injected into
  // package.json only at publish time), so resolution must miss gracefully.
  assert.equal(resolvePlatformBinary("linux", "x64"), null);
  // Unsupported platform short-circuits before require.resolve.
  assert.equal(resolvePlatformBinary("freebsd", "x64"), null);
});
