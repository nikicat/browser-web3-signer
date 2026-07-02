/**
 * Spawns and supervises the Rust `serve` control-API subprocess for the lifetime of this client.
 *
 * This is the cross-language analog of the reference's in-process HTTP server: the Rust process
 * owns the bridge and the persistent browser tab on a stable port, and we drive it over
 * `/api/v1`. One subprocess per {@link ServeProcess}; it dies when we call {@link stop} (or when
 * this process exits).
 */

import { execFile, type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolvePlatformBinary, supportedPlatforms, platformPackage } from "./platform.ts";

/** Which chain the spawned `serve` process drives. */
export type Chain = "evm" | "tron";

/** Options for {@link ServeProcess}. */
export interface ServeProcessOptions {
  /**
   * Path to the `browser-web3-signer` binary. When omitted, the binary is resolved from
   * the `BROWSER_WEB3_SIGNER_BIN` env var, then a workspace debug/release build (only
   * when running from the repo checkout), then the installed
   * `@nikicat/browser-web3-signer-<platform>` package (how the published package ships
   * the binary), then `browser-web3-signer` on `PATH`.
   */
  binPath?: string;
  /**
   * How the bridge opens the approval page. `undefined` (default) opens the OS browser; a
   * program name (set via the BROWSER env var) opens that browser; `"print"` opens nothing (the
   * caller surfaces the URL).
   */
  browser?: string | "print";
}

// This file lives at ts/src (dev) or <pkg>/dist (installed); the workspace root is two levels
// up in a repo checkout. When installed under node_modules the candidate paths simply miss.
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(PKG_DIR, "../..");

/** Where a resolved binary came from — decides whether the version handshake runs. */
type ResolvedBinary = {
  path: string;
  /** Sources with an exact version by construction skip the `--version` check. */
  source: "explicit" | "env" | "workspace" | "platform-package" | "path";
};

/** Find `name` on PATH (honoring PATHEXT on Windows), or null. */
function findOnPath(name: string): string | null {
  const pathVar = process.env.PATH ?? "";
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve the signer binary through the documented fallback chain. Throws if not found. */
function resolveBinary(explicit?: string): ResolvedBinary {
  if (explicit) return { path: explicit, source: "explicit" };

  const env = process.env.BROWSER_WEB3_SIGNER_BIN;
  if (env) return { path: env, source: "env" };

  const workspaceCandidates = [
    resolve(WORKSPACE_ROOT, "target/release/browser-web3-signer"),
    resolve(WORKSPACE_ROOT, "target/debug/browser-web3-signer"),
  ];
  const workspace = workspaceCandidates.find((p) => existsSync(p));
  if (workspace) return { path: workspace, source: "workspace" };

  const platformPkg = resolvePlatformBinary();
  if (platformPkg) return { path: platformPkg, source: "platform-package" };

  const onPath = findOnPath("browser-web3-signer");
  if (onPath) return { path: onPath, source: "path" };

  const target = platformPackage();
  const hint =
    "set BROWSER_WEB3_SIGNER_BIN, put browser-web3-signer on PATH, or build from source with `cargo build --release`";
  if (!target) {
    throw new Error(
      `browser-web3-signer has no prebuilt binary for ${process.platform}-${process.arch} ` +
        `(supported: ${supportedPlatforms()}); ${hint}`,
    );
  }
  throw new Error(
    `browser-web3-signer binary not found: ${target.pkg} is not installed ` +
      `(if this project was installed with a lockfile written on another platform, ` +
      `reinstall to pick up the platform package — see https://github.com/npm/cli/issues/4828); ${hint}`,
  );
}

/** This package's own version, for the binary version handshake. */
function packageVersion(): string {
  // ../package.json resolves from both ts/src (dev) and <pkg>/dist (installed).
  const require = createRequire(import.meta.url);
  return (require("../package.json") as { version: string }).version;
}

/**
 * Warn when a binary of unknown provenance (workspace build or PATH) reports a version
 * different from this package. Never throws — a skewed dev build is usually fine.
 */
async function warnOnVersionMismatch(binPath: string): Promise<void> {
  const expected = packageVersion();
  const reported = await new Promise<string | null>((done) => {
    execFile(binPath, ["--version"], { timeout: 10_000 }, (err, stdout) =>
      done(err ? null : stdout.trim()),
    );
  });
  if (reported === null) {
    console.warn(`browser-web3-signer: could not check the version of ${binPath}`);
  } else if (!reported.includes(expected)) {
    console.warn(
      `browser-web3-signer: binary at ${binPath} reports "${reported}" but this package is ` +
        `v${expected}; behavior may differ`,
    );
  }
}

/** A running `serve` subprocess plus the base URL of its control API. */
export class ServeProcess {
  #proc: ChildProcess | null = null;
  #baseUrl = "";
  readonly #chain: Chain;
  readonly #explicitBin?: string;
  readonly #browser?: string;
  #binPath: string | null = null;

  constructor(chain: Chain, options?: ServeProcessOptions) {
    this.#chain = chain;
    this.#explicitBin = options?.binPath;
    this.#browser = options?.browser;
  }

  /** The control-API base URL (`http://127.0.0.1:<port>`), or `""` before {@link start}. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** Spawn the subprocess and resolve once it reports its bound port on stdout. */
  async start(): Promise<string> {
    if (this.#proc) return this.#baseUrl;

    if (this.#binPath === null) {
      const resolved = resolveBinary(this.#explicitBin);
      if (resolved.source === "workspace" || resolved.source === "path") {
        await warnOnVersionMismatch(resolved.path);
      }
      this.#binPath = resolved.path;
    }
    const binPath = this.#binPath;

    const args: string[] = [];
    // "print" opens no browser; a specific browser is selected via the BROWSER env var (the
    // signer has no --browser flag — it honors $BROWSER, like xdg-open / the `open` convention).
    const env = { ...process.env };
    if (this.#browser === "print") {
      args.push("--print");
    } else if (this.#browser) {
      env.BROWSER = this.#browser;
    }
    args.push("serve", "--chain", this.#chain);

    const proc = spawn(binPath, args, { stdio: ["ignore", "pipe", "inherit"], env });
    this.#proc = proc;

    const port = await new Promise<number>((resolvePort, reject) => {
      let buf = "";
      proc.stdout!.on("data", (data: Buffer) => {
        buf += data.toString("utf-8");
        const newline = buf.indexOf("\n");
        if (newline === -1) return; // wait for a full line
        const line = buf.slice(0, newline).trim();
        if (line.length > 0) {
          const parsed = Number.parseInt(line, 10);
          if (Number.isNaN(parsed)) {
            reject(new Error(`${binPath} printed a non-numeric port: ${line}`));
          } else {
            resolvePort(parsed);
          }
        }
      });
      proc.on("error", (err) => reject(new Error(`failed to spawn ${binPath}: ${err.message}`)));
      proc.on("exit", (code) => {
        if (code !== null && code !== 0) reject(new Error(`serve exited early with code ${code}`));
      });
    });

    this.#baseUrl = `http://127.0.0.1:${port}`;
    return this.#baseUrl;
  }

  /** Kill the subprocess. Idempotent. */
  async stop(): Promise<void> {
    if (this.#proc) {
      this.#proc.kill();
      this.#proc = null;
      this.#baseUrl = "";
    }
  }
}
