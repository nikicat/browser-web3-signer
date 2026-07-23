/**
 * Shared plumbing for the Ambire demo tooling: anvil lifecycle, booting Ambire
 * from the baked fixture (storage injection + relaunch + unlock), request-window
 * approval, and running the CLI. See README.md for the operational notes behind
 * the non-obvious moves here.
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANVIL_CHAIN_ID, ANVIL_RPC, CHROMIUM_ARGS, FIXTURE, KEYSTORE_PASS } from "./config.mts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const children: ChildProcess[] = [];
export function registerCleanup(extra?: () => void): void {
  process.on("exit", () => {
    extra?.();
    children.forEach((c) => c.kill());
  });
}

export type Rpc = (method: string, params?: unknown[]) => Promise<any>;

/** Spawn a fresh anvil (refusing stale listeners) and mine past genesis. */
export async function startAnvil(logPath: string): Promise<Rpc> {
  const taken = await fetch(ANVIL_RPC, { method: "POST", signal: AbortSignal.timeout(1000) })
    .then(() => true)
    .catch(() => false);
  if (taken) throw new Error("something is already listening on 8545 — kill stale anvil first");

  const log = createWriteStream(logPath);
  const anvil = spawn("anvil", ["--chain-id", String(ANVIL_CHAIN_ID)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  anvil.stdout.pipe(log);
  anvil.stderr.pipe(log);
  children.push(anvil);

  const rpc: Rpc = async (method, params = []) => {
    const res = await fetch(ANVIL_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()).result;
  };
  for (let i = 0; ; i++) {
    try {
      if ((await rpc("eth_chainId")) === "0x7a69") break;
    } catch {}
    if (i > 50) throw new Error("anvil did not come up");
    await sleep(200);
  }
  // Gas estimation asks for "previous block" (−1), unresolvable at genesis.
  await rpc("anvil_mine", ["0x5"]);
  return rpc;
}

export function loadFixture(): Record<string, unknown> {
  const storage = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString("utf8"));
  if (!String(storage.networks).includes(String(ANVIL_CHAIN_ID))) {
    throw new Error("fixture has no Anvil network — re-run bake.mts");
  }
  return storage;
}

const findSw = async (c: BrowserContext) => {
  for (let i = 0; i < 100; i++) {
    const sw = c.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
    if (sw) return sw;
    await sleep(200);
  }
  throw new Error("no service worker");
};

/**
 * Boot Ambire fully onboarded: inject the fixture in a throwaway launch, close,
 * relaunch (background races injection on first boot; chrome.runtime.reload()
 * breaks unpacked extensions), then unlock.
 */
export async function bootAmbire(opts: { extraArgs?: string[]; cursorOverlay?: boolean } = {}): Promise<{
  ctx: BrowserContext;
  extId: string;
  tab: Page;
}> {
  const storage = loadFixture();
  const profile = mkdtempSync(join(tmpdir(), "ambire-demo-"));
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: false,
      viewport: null,
      args: [...CHROMIUM_ARGS, ...(opts.extraArgs ?? [])],
    });

  let ctx = await launch();
  const sw = await findSw(ctx);
  const extId = sw.url().split("/")[2];
  await sleep(2000);
  await sw.evaluate(
    (params) => chrome.storage.local.set(params),
    { ...storage, isE2EStorageSet: true, isSetupComplete: "true" },
  );
  await sleep(1000);
  await ctx.close();

  ctx = await launch();
  await findSw(ctx);

  if (opts.cursorOverlay) {
    // Screen capture shows no OS cursor; draw one that follows Playwright's mouse.
    await ctx.addInitScript(`
window.addEventListener("DOMContentLoaded", () => {
  const dot = document.createElement("div");
  dot.id = "pw-cursor-dot";
  dot.style.cssText = "position:fixed;z-index:99999;width:16px;height:16px;border-radius:50%;" +
    "background:rgba(30,30,30,.5);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);" +
    "pointer-events:none;transform:translate(-50%,-50%);left:-40px;top:-40px";
  document.body.appendChild(dot);
  window.addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
});
`);
  }

  const tab = await ctx.newPage();
  tab.setDefaultTimeout(60000);
  let unlocked = false;
  for (let i = 0; i < 5 && !unlocked; i++) {
    await tab.goto(`chrome-extension://${extId}/tab.html#/`, { waitUntil: "load" }).catch(() => {});
    unlocked = await tab
      .getByTestId("passphrase-field")
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!unlocked) await tab.waitForTimeout(2000);
  }
  if (!unlocked) throw new Error("unlock screen never appeared");
  await tab.getByTestId("passphrase-field").fill(KEYSTORE_PASS);
  await tab.getByTestId("button-unlock").click();
  await sleep(2500);

  return { ctx, extId, tab };
}

/** Ambire reuses one request window; 'page' events are unreliable under Xvfb. */
export const findRequestWindow = (ctx: BrowserContext): Page | undefined =>
  ctx.pages().find((p) => !p.isClosed() && p.url().includes("request-window"));

/** Eased, human-paced cursor glide (Playwright's steps run too fast on camera). */
export async function glideTo(page: Page, x: number, y: number, ms = 900): Promise<void> {
  const steps = Math.max(24, Math.floor(ms / 16));
  // Current cursor position is not exposed by Playwright — read the overlay dot.
  const start = await page
    .evaluate(() => {
      const d = document.getElementById("pw-cursor-dot");
      if (!d || !d.style.left) return null;
      return { x: parseFloat(d.style.left), y: parseFloat(d.style.top) };
    })
    .catch(() => null)
    .then((p) => p ?? { x: x - 260, y: y + 180 });
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
    await page.mouse.move(start.x + (x - start.x) * e, start.y + (y - start.y) * e);
    await sleep(ms / steps);
  }
}

/** Absolute screen coords of an element's center (for camera targeting). */
export async function screenCenterOf(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<{ cx: number; cy: number }> {
  const w = await page.evaluate(() => ({
    sx: window.screenX,
    sy: window.screenY,
    ow: window.outerWidth,
    oh: window.outerHeight,
    iw: window.innerWidth,
    ih: window.innerHeight,
  }));
  const borderX = Math.max(0, (w.ow - w.iw) / 2);
  const header = Math.max(0, w.oh - w.ih - borderX);
  return { cx: w.sx + borderX + box.x + box.width / 2, cy: w.sy + header + box.y + box.height / 2 };
}

export interface ApproveOptions {
  rounds?: number;
  pauseMs?: number; // dwell before clicking (viewer pacing in recordings)
  glide?: boolean; // move the (overlay) cursor to the button before clicking
  verbose?: boolean;
}

/** Poll for the request window and click the first matching approve button. */
export async function approveRequestWindow(
  ctx: BrowserContext,
  ids: string[],
  { rounds = 12, pauseMs = 300, glide = false, verbose = false }: ApproveOptions = {},
): Promise<string | null> {
  for (let round = 0; round < rounds; round++) {
    await sleep(2000);
    const popup = findRequestWindow(ctx);
    if (!popup) {
      if (verbose) console.log(`[approve] round ${round}: no request window`);
      continue;
    }
    await popup.waitForLoadState("load").catch(() => {});
    await sleep(pauseMs);
    for (const tid of ids) {
      const b = popup.getByTestId(tid).first();
      if (await b.isVisible().catch(() => false)) {
        if (glide) {
          const box = await b.boundingBox().catch(() => null);
          if (box) await popup.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
          await sleep(300);
        }
        await b.click().catch(() => {});
        if (verbose) console.log(`[approve] round ${round}: clicked ${tid}`);
        return tid;
      }
    }
    if (verbose) {
      const idsSeen = await popup
        .evaluate(() =>
          Array.from(document.querySelectorAll("[data-testid]")).slice(0, 25).map((e) => e.getAttribute("data-testid")).join(","),
        )
        .catch(() => "(gone)");
      console.log(`[approve] round ${round}: ${popup.url().split("#")[1]} no match; ids: ${idsSeen}`);
    }
  }
  return null;
}

export interface CliRun {
  url: Promise<string>;
  exit: Promise<number | null>;
  out: () => string;
  err: () => string;
}

/** Run the CLI with --print/--json; resolves the approval URL from stderr. */
export function runCli(cliPath: string, args: string[]): CliRun {
  const cli = spawn(cliPath, [...args, "--print", "--json"]);
  children.push(cli);
  let out = "";
  let err = "";
  cli.stdout.on("data", (d: Buffer) => (out += d.toString()));
  cli.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const url = new Promise<string>((resolve, reject) => {
    cli.stderr.on("data", () => {
      const m = err.match(/Approval URL: (\S+)/);
      if (m) resolve(m[1]);
    });
    cli.on("exit", (code) => reject(new Error(`CLI exited early (${code}): ${err}`)));
  });
  const exit = new Promise<number | null>((resolve) => cli.on("exit", resolve));
  return { url, exit, out: () => out, err: () => err };
}
