/**
 * Maps the running platform to the npm platform package that carries the prebuilt
 * `browser-web3-signer` binary for it (the esbuild-style `optionalDependencies` pattern:
 * the main package pins one `@nikicat/browser-web3-signer-<platform>` per supported
 * target, and npm installs only the matching one).
 *
 * The platform names must stay in sync with `scripts/npm-platform.mjs`, which generates
 * and publishes the packages at release time.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Platform-package suffix + binary filename per supported (platform, arch) pair. */
const SUPPORTED: Record<string, string> = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "win32-x64",
};

/** The npm package + binary filename for a (platform, arch) pair, or null if unsupported. */
export function platformPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { pkg: string; exe: string } | null {
  const name = SUPPORTED[`${platform}-${arch}`];
  if (!name) return null;
  return {
    pkg: `@nikicat/browser-web3-signer-${name}`,
    exe: platform === "win32" ? "browser-web3-signer.exe" : "browser-web3-signer",
  };
}

/** A human-readable list of the supported platforms, for error messages. */
export function supportedPlatforms(): string {
  return Object.keys(SUPPORTED).join(", ");
}

/**
 * Resolve the prebuilt binary from the installed platform package, or null when the
 * package is not installed (unsupported platform, dev checkout, or the npm lockfile bug
 * where a lockfile written on another platform omits this platform's optional dep —
 * see https://github.com/npm/cli/issues/4828).
 */
export function resolvePlatformBinary(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const target = platformPackage(platform, arch);
  if (!target) return null;
  // Prefer the consumer's top-level `node_modules` entry over `require.resolve`: resolve()
  // returns the realpath, which under Deno's node_modules layout lands in the *versioned*
  // `.deno/<pkg>@<version>` store — a path that changes on every release, so a sandboxed
  // consumer could never allowlist it statically (`--allow-run` matches the literal spawn path).
  // The top-level path is version-independent; npm hoists the platform package there, and Deno
  // creates it when the consumer declares the platform package as a direct dependency.
  const topLevel = join(process.cwd(), "node_modules", target.pkg, "bin", target.exe);
  if (existsSync(topLevel)) return topLevel;
  const require = createRequire(import.meta.url);
  try {
    return require.resolve(`${target.pkg}/bin/${target.exe}`);
  } catch {
    return null;
  }
}
