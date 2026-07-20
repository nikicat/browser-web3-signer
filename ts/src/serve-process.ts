/**
 * Spawns and supervises the Rust `serve` control-API subprocess for the lifetime of this client.
 *
 * This is the cross-language analog of the reference's in-process HTTP server: the Rust process
 * owns the bridge and the persistent browser tab on a stable port, and we drive it over
 * `/api/v1`. One subprocess per {@link ServeProcess}; it dies when we call {@link stop} (or when
 * this process exits).
 */

import { execFile, spawn } from "node:child_process";
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
   * the binary; the consumer's top-level `node_modules` entry is preferred over the
   * realpathed store so sandboxed runtimes can allowlist a stable path), then
   * `browser-web3-signer` on `PATH`.
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

/** The slice of a spawned child both runtime paths expose: enough for teardown. */
interface ServeChild {
  kill(): void;
}

/** Minimal local typing for the `Deno` global (this package ships no Deno types). Under Deno,
 *  `node:child_process` substitutes the permission-filtered `process.env` even when `env` is
 *  omitted — stripping PATH/DISPLAY/… the child needs to launch a browser — so we feature-detect
 *  `Deno.Command`, which inherits the real environment and *merges* `env` over it. */
interface DenoNamespaceLike {
  Command: new (
    command: string | URL,
    options: {
      args: string[];
      stdin: "null";
      stdout: "piped";
      stderr: "inherit";
      env?: Record<string, string>;
    },
  ) => {
    spawn(): {
      readonly stdout: ReadableStream<Uint8Array>;
      readonly status: Promise<{ code: number }>;
      kill(): void;
    };
  };
}

const denoNs: DenoNamespaceLike | undefined = (globalThis as { Deno?: DenoNamespaceLike }).Deno;

/** A running `serve` subprocess plus the base URL of its control API. */
export class ServeProcess implements AsyncDisposable {
  #proc: ServeChild | null = null;
  #starting: Promise<string> | null = null;
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

  /** Spawn the subprocess and resolve once it reports its bound port on stdout. Concurrent and
   *  repeat calls share one spawn; a failed spawn clears the slot so the next call retries. */
  start(): Promise<string> {
    this.#starting ??= this.#doStart().catch((err) => {
      this.#starting = null;
      throw err;
    });
    return this.#starting;
  }

  async #doStart(): Promise<string> {
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
    let browserEnv: string | undefined;
    if (this.#browser === "print") {
      args.push("--print");
    } else if (this.#browser) {
      browserEnv = this.#browser;
    }
    args.push("serve", "--chain", this.#chain);

    const port = denoNs
      ? await this.#spawnDeno(denoNs, binPath, args, browserEnv)
      : await this.#spawnNode(binPath, args, browserEnv);

    this.#baseUrl = `http://127.0.0.1:${port}`;
    return this.#baseUrl;
  }

  /** Spawn via `node:child_process`. `env` is omitted unless BROWSER must be injected, so the
   *  child inherits the parent environment untouched. */
  #spawnNode(binPath: string, args: string[], browserEnv: string | undefined): Promise<number> {
    const env = browserEnv === undefined ? undefined : { ...process.env, BROWSER: browserEnv };
    const proc = spawn(binPath, args, { stdio: ["ignore", "pipe", "inherit"], env });
    this.#proc = proc;

    return new Promise<number>((resolvePort, reject) => {
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
  }

  /** Spawn via `Deno.Command`: the child inherits the *real* environment (not the
   *  permission-filtered view `node:child_process` passes), and `env` merges over it. */
  async #spawnDeno(
    deno: DenoNamespaceLike,
    binPath: string,
    args: string[],
    browserEnv: string | undefined,
  ): Promise<number> {
    let child: ReturnType<InstanceType<DenoNamespaceLike["Command"]>["spawn"]>;
    try {
      child = new deno.Command(binPath, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "inherit",
        ...(browserEnv === undefined ? {} : { env: { BROWSER: browserEnv } }),
      }).spawn();
    } catch (err) {
      throw new Error(`failed to spawn ${binPath}: ${err instanceof Error ? err.message : err}`);
    }
    this.#proc = child;

    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const status = await child.status;
        throw new Error(`serve exited early with code ${status.code}`);
      }
      buf += decoder.decode(value, { stream: true });
      const newline = buf.indexOf("\n");
      if (newline === -1) continue; // wait for a full line
      const line = buf.slice(0, newline).trim();
      if (line.length === 0) {
        buf = buf.slice(newline + 1);
        continue;
      }
      // Drain any further stdout in the background so the pipe can't fill up.
      void (async () => {
        while (!(await reader.read()).done) {
          // discard
        }
      })().catch(() => {});
      const parsed = Number.parseInt(line, 10);
      if (Number.isNaN(parsed)) throw new Error(`${binPath} printed a non-numeric port: ${line}`);
      return parsed;
    }
  }

  /** Kill the subprocess. Idempotent. */
  async stop(): Promise<void> {
    if (this.#proc) {
      this.#proc.kill();
      this.#proc = null;
      this.#starting = null;
      this.#baseUrl = "";
    }
  }

  /** `await using serve = new ServeProcess(...)` — {@link stop} on scope exit. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}
