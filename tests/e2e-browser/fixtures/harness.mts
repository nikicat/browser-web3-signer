/**
 * Shared harness driver for the e2e browser tests.
 *
 * Spawns a Rust harness binary (`evm-harness` / `tron-harness`, built with
 * `cargo build --features e2e`) instead of an in-process Deno server. The harness prints its
 * bound port to stdout; we read that and expose the same API the reference `test-server.mts`
 * did, so the per-chain specs stay byte-compatible with the upstream suite.
 *
 * `makeHarness(binName)` returns a fresh, independently-stated driver, so the EVM and TRON
 * suites each spawn and tear down their own process.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Workspace root is three levels up from tests/e2e-browser/fixtures.
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(FIXTURE_DIR, "../../..");

/** Locate a built harness binary by name, preferring release over debug. */
function harnessPath(binName: string): string {
  const candidates = [
    resolve(WORKSPACE_ROOT, `target/release/${binName}`),
    resolve(WORKSPACE_ROOT, `target/debug/${binName}`),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `${binName} binary not found. Build it first:\n` +
        `  cargo build --bin ${binName} --features e2e\n` +
        `Looked in:\n  ${candidates.join("\n  ")}`,
    );
  }
  return found;
}

export type RequestType =
  | "connect"
  | "send_transaction"
  | "trigger_contract"
  | "deploy_contract"
  | "sign_message"
  | "sign_typed_data";

export interface TestResult {
  success: boolean;
  result?: string;
  error?: string;
  pending?: boolean;
}

export interface Harness {
  startServer(): Promise<number>;
  stopServer(): Promise<void>;
  getBaseUrl(): string;
  createTestRequest(type: RequestType, data?: Record<string, unknown>): Promise<{ id: string }>;
  getTestResult(id: string): Promise<TestResult | null>;
}

/** Build a harness driver bound to a specific Rust harness binary. */
export function makeHarness(binName: string): Harness {
  let proc: ReturnType<typeof spawn> | null = null;
  let baseUrl = "";

  async function startServer(): Promise<number> {
    proc = spawn(harnessPath(binName), [], { stdio: ["ignore", "pipe", "inherit"] });

    const port = await new Promise<number>((resolvePort, reject) => {
      proc!.stdout!.on("data", (data: Buffer) => {
        const line = data.toString("utf-8").trim();
        const parsed = parseInt(line, 10);
        if (Number.isNaN(parsed)) {
          reject(new Error(`${binName} printed non-numeric port: ${line}`));
        } else {
          resolvePort(parsed);
        }
      });
      proc!.on("error", (err) => reject(new Error(`failed to spawn ${binName}: ${err.message}`)));
      proc!.on("exit", (code) => {
        if (code !== null && code !== 0) reject(new Error(`${binName} exited with code ${code}`));
      });
    });

    baseUrl = `http://127.0.0.1:${port}`;
    return port;
  }

  async function stopServer(): Promise<void> {
    if (proc) {
      proc.kill();
      proc = null;
      baseUrl = "";
    }
  }

  const getBaseUrl = (): string => baseUrl;

  async function createTestRequest(
    type: RequestType,
    data: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const res = await fetch(`${baseUrl}/api/test/create-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, ...data }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create request: ${res.status} ${text}`);
    }
    return res.json();
  }

  async function getTestResult(id: string): Promise<TestResult | null> {
    const res = await fetch(`${baseUrl}/api/test/result/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to get result: ${res.status}`);
    return res.json();
  }

  return { startServer, stopServer, getBaseUrl, createTestRequest, getTestResult };
}
