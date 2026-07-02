#!/usr/bin/env node
// Generates the per-platform npm packages that carry the prebuilt browser-web3-signer
// binary, and injects them as exact-pinned optionalDependencies into the main package
// (the esbuild pattern). Used by .github/workflows/release.yml; runnable locally for
// inspection. Zero dependencies; Node >= 22.
//
// Usage:
//   node scripts/npm-platform.mjs gen <version> <dist-dir> <out-dir>
//     <dist-dir> holds the release assets named browser-web3-signer-<target>[.exe];
//     writes one publishable package per platform to <out-dir>/<platform>/.
//   node scripts/npm-platform.mjs inject <version> <path-to-package.json>
//     adds optionalDependencies pinned to exactly <version>. Publish-time only —
//     never commit the result (the packages don't exist on npm until the release).
//
// The platform list must stay in sync with ts/src/platform.ts.

import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Rust target triple → npm platform package descriptor. */
const TARGETS = {
  "x86_64-unknown-linux-musl": { platform: "linux-x64", os: "linux", cpu: "x64", exe: "" },
  "aarch64-unknown-linux-musl": { platform: "linux-arm64", os: "linux", cpu: "arm64", exe: "" },
  "x86_64-apple-darwin": { platform: "darwin-x64", os: "darwin", cpu: "x64", exe: "" },
  "aarch64-apple-darwin": { platform: "darwin-arm64", os: "darwin", cpu: "arm64", exe: "" },
  "x86_64-pc-windows-msvc": { platform: "win32-x64", os: "win32", cpu: "x64", exe: ".exe" },
};

const SCOPE = "@nikicat/browser-web3-signer-";

function pkgName(platform) {
  return `${SCOPE}${platform}`;
}

function gen(version, distDir, outDir) {
  for (const [target, { platform, os, cpu, exe }] of Object.entries(TARGETS)) {
    const asset = join(distDir, `browser-web3-signer-${target}${exe}`);
    const pkgDir = join(outDir, platform);
    const binDir = join(pkgDir, "bin");
    mkdirSync(binDir, { recursive: true });

    const bin = join(binDir, `browser-web3-signer${exe}`);
    copyFileSync(asset, bin); // throws if the asset is missing — all 5 are required
    chmodSync(bin, 0o755);

    // No "bin" field: the file is data resolved by the main package via require.resolve,
    // not a CLI entry point. The musl linux binaries are static, so no libc field.
    writeFileSync(
      join(pkgDir, "package.json"),
      `${JSON.stringify(
        {
          name: pkgName(platform),
          version,
          description: `Prebuilt browser-web3-signer binary for ${platform}. Installed automatically by the browser-web3-signer package.`,
          license: "MIT",
          repository: {
            type: "git",
            url: "git+https://github.com/nikicat/browser-web3-signer.git",
          },
          os: [os],
          cpu: [cpu],
          files: ["bin"],
        },
        null,
        2,
      )}\n`,
    );
    console.log(`generated ${pkgName(platform)}@${version} from ${asset}`);
  }
}

function inject(version, packageJsonPath) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  pkg.optionalDependencies = Object.fromEntries(
    Object.values(TARGETS).map(({ platform }) => [pkgName(platform), version]),
  );
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(
    `injected ${Object.keys(pkg.optionalDependencies).length} optionalDependencies pinned to ${version} into ${packageJsonPath}`,
  );
}

const [mode, version, ...rest] = process.argv.slice(2);
if (mode === "gen" && version && rest.length === 2) {
  gen(version, rest[0], rest[1]);
} else if (mode === "inject" && version && rest.length === 1) {
  inject(version, rest[0]);
} else {
  console.error(
    "usage: npm-platform.mjs gen <version> <dist-dir> <out-dir> | inject <version> <package.json>",
  );
  process.exit(2);
}
