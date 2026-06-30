/**
 * Test server utilities for e2e browser tests.
 *
 * Spawns the Rust e2e-harness binary (built with `cargo build --bin e2e-harness --features e2e`)
 * instead of starting an in-process Deno server. The harness prints its bound port to stdout;
 * we read that and use it as the base URL.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let proc: ReturnType<typeof spawn> | null = null;
let baseUrl = "";

// Workspace root is three levels up from tests/e2e-browser/fixtures.
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(FIXTURE_DIR, "../../..");

/** Locate the built harness binary, preferring release over debug. */
function harnessPath(): string {
  const candidates = [
    resolve(WORKSPACE_ROOT, "target/release/e2e-harness"),
    resolve(WORKSPACE_ROOT, "target/debug/e2e-harness"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `e2e-harness binary not found. Build it first:\n` +
        `  cargo build --bin e2e-harness --features e2e\n` +
        `Looked in:\n  ${candidates.join("\n  ")}`,
    );
  }
  return found;
}

/**
 * Start the Rust e2e-harness binary and read its bound port from stdout.
 */
export async function startServer(): Promise<number> {
  proc = spawn(harnessPath(), [], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  // Read the first line of stdout: it's the port.
  const port = await new Promise<number>((resolve, reject) => {
    proc!.stdout!.on("data", (data: Buffer) => {
      const line = data.toString("utf-8").trim();
      const parsed = parseInt(line, 10);
      if (Number.isNaN(parsed)) {
        reject(new Error(`e2e-harness printed non-numeric port: ${line}`));
      } else {
        resolve(parsed);
      }
    });

    proc!.on("error", (err) => {
      reject(new Error(`failed to spawn e2e-harness: ${err.message}`));
    });

    // If the harness exits early, propagate the error.
    proc!.on("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`e2e-harness exited with code ${code}`));
      }
    });
  });

  baseUrl = `http://127.0.0.1:${port}`;
  return port;
}

/**
 * Kill the harness process.
 */
export async function stopServer(): Promise<void> {
  if (proc) {
    proc.kill();
    proc = null;
    baseUrl = "";
  }
}

/** The base URL the harness is serving on. */
export function getBaseUrl(): string {
  return baseUrl;
}

/**
 * Create a pending request via the test API.
 */
export async function createTestRequest(
  type: "connect" | "send_transaction" | "sign_message" | "sign_typed_data",
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

/**
 * Get the result of a completed request.
 */
export async function getTestResult(
  id: string,
): Promise<{ success: boolean; result?: string; error?: string; pending?: boolean } | null> {
  const res = await fetch(`${baseUrl}/api/test/result/${id}`);

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to get result: ${res.status}`);

  return res.json();
}
