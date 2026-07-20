/**
 * Unit tests for the platform → npm-platform-package mapping. Hermetic: no Rust binary,
 * no network — the integration suite (wallet-signer.test.ts) covers actual spawning.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("prefers the consumer's top-level node_modules entry over require.resolve", (t) => {
  const target = platformPackage();
  if (!target) return t.skip("no platform package for this host");

  // A fake consumer project: the platform package laid out at the top level (as npm hoists it,
  // and as Deno lays out direct deps). The resolver must return this stable path verbatim — not
  // a realpath into a versioned store — so sandboxed runtimes can allowlist it statically.
  // realpath: macOS's tmpdir is a symlink (/var → /private/var) and process.cwd() reports the
  // resolved path after chdir, which is what the resolver builds the candidate from.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bw3s-platform-")));
  const binDir = join(dir, "node_modules", target.pkg, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, target.exe), "");
  const prevCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(resolvePlatformBinary(), join(dir, "node_modules", target.pkg, "bin", target.exe));
});
