/**
 * Spawns and supervises the Rust `serve` control-API subprocess for the lifetime of this client.
 *
 * This is the cross-language analog of the reference's in-process HTTP server: the Rust process
 * owns the bridge and the persistent browser tab on a stable port, and we drive it over
 * `/api/v1`. One subprocess per {@link ServeProcess}; it dies when we call {@link stop} (or when
 * this process exits).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** Which chain the spawned `serve` process drives. */
export type Chain = "evm" | "tron";

/** Options for {@link ServeProcess}. */
export interface ServeProcessOptions {
  /**
   * Path to the `browser-web3-signer` binary. Defaults to the workspace debug/release build
   * (resolved relative to this package), then falls back to `browser-web3-signer` on `PATH`.
   */
  binPath?: string;
  /**
   * How the bridge opens the approval page. `undefined` (default) opens the OS browser;
   * a name opens that browser; `"print"` opens nothing (the caller surfaces the URL).
   */
  browser?: string | "print";
}

// This file lives at ts/src; the workspace root is two levels up.
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(PKG_DIR, "../..");

/** Resolve the signer binary, preferring an explicit path, then release/debug builds, then PATH. */
function resolveBinary(explicit?: string): string {
  if (explicit) return explicit;
  const candidates = [
    resolve(WORKSPACE_ROOT, "target/release/browser-web3-signer"),
    resolve(WORKSPACE_ROOT, "target/debug/browser-web3-signer"),
  ];
  return candidates.find((p) => existsSync(p)) ?? "browser-web3-signer";
}

/** A running `serve` subprocess plus the base URL of its control API. */
export class ServeProcess {
  #proc: ChildProcess | null = null;
  #baseUrl = "";
  readonly #chain: Chain;
  readonly #binPath: string;
  readonly #browser?: string;

  constructor(chain: Chain, options?: ServeProcessOptions) {
    this.#chain = chain;
    this.#binPath = resolveBinary(options?.binPath);
    this.#browser = options?.browser;
  }

  /** The control-API base URL (`http://127.0.0.1:<port>`), or `""` before {@link start}. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** Spawn the subprocess and resolve once it reports its bound port on stdout. */
  async start(): Promise<string> {
    if (this.#proc) return this.#baseUrl;

    const args: string[] = [];
    if (this.#browser === "print") {
      args.push("--print");
    } else if (this.#browser) {
      args.push("--browser", this.#browser);
    }
    args.push("serve", "--chain", this.#chain);

    const proc = spawn(this.#binPath, args, { stdio: ["ignore", "pipe", "inherit"] });
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
            reject(new Error(`${this.#binPath} printed a non-numeric port: ${line}`));
          } else {
            resolvePort(parsed);
          }
        }
      });
      proc.on("error", (err) => reject(new Error(`failed to spawn ${this.#binPath}: ${err.message}`)));
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
