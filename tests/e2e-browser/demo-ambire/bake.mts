/**
 * One-time "bake": drive Ambire's real onboarding (import anvil account-0
 * private key, set keystore password), then dump the fixture-worthy subset of
 * chrome.storage.local to ambire-storage.json. drive.mts injects that dump and
 * skips onboarding entirely — Ambire's own e2e mechanism (see their
 * e2e-playwright-tests/common-helpers/bootstrap.ts).
 *
 * Only needed again when bumping AMBIRE_VERSION (or changing the account):
 *   ./setup.sh && xvfb-run -a node bake.mts
 */

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANVIL_CHAIN_ID,
  ANVIL_KEY,
  ANVIL_RPC,
  CHROMIUM_ARGS,
  FIXTURE,
  FIXTURE_KEYS,
  KEYSTORE_PASS,
} from "./config.mts";

// The network-add UI probes the RPC to detect the chain id, so anvil must run
// during the bake.
const anvil = spawn("anvil", ["--chain-id", String(ANVIL_CHAIN_ID)], { stdio: "ignore" });
process.on("exit", () => anvil.kill());
await new Promise((r) => setTimeout(r, 1500));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ambire-bake-")), {
  channel: "chromium",
  headless: false,
  viewport: null,
  args: CHROMIUM_ARGS,
});

let sw;
for (let i = 0; i < 100 && !sw; i++) {
  sw = ctx.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (!sw) await new Promise((r) => setTimeout(r, 200));
}
if (!sw) throw new Error("extension service worker not found");
const extId = sw.url().split("/")[2];

const page = await ctx.newPage();
page.setDefaultTimeout(60000);

process.on("uncaughtException", async (e) => {
  console.error("FAILED:", e.message, "\nurl:", page.url());
  await page.screenshot({ path: "bake-fail.png" }).catch(() => {});
  process.exit(1);
});

await page.goto(`chrome-extension://${extId}/tab.html#/get-started`, { waitUntil: "load" });

const click = async (id: string) => {
  await page.getByTestId(id).first().waitFor({ state: "visible" });
  await page.getByTestId(id).first().click();
};

// Import basic account from private key (release build: no story screens)
await click("import-existing-account-btn");
await click("import-method-private-key");
await page.getByTestId("enter-private-key-field").fill(ANVIL_KEY);
await click("backup-warning-checkbox");
await click("import-button");

// Set keystore password
await page.getByTestId("enter-pass-field").fill(KEYSTORE_PASS);
await page.getByTestId("repeat-pass-field").fill(KEYSTORE_PASS);
await click("create-keystore-pass-btn");

// Release build goes straight to wallet-setup-completed
await page.getByTestId("wallet-ready-to-use-text").waitFor();
await click("onboarding-completed-open-dashboard-btn");
await page.waitForTimeout(3000); // let state settle

// Add the Anvil network through the real settings UI so the fixture carries a
// canonically-shaped custom-network entry (mirrors their addNetworkManually flow;
// the chain id is auto-detected from the RPC probe).
await page.goto(`chrome-extension://${extId}/tab.html#/settings/networks`, { waitUntil: "load" });
await click("add-network-manually");
const field = (label: string) => page.locator(`//div[text()="${label}"]/following-sibling::div//input`);
await field("Network name").fill("Anvil (local)");
await field("Currency Symbol").fill("ETH");
await field("Currency Name").fill("Ether");
await field("Add RPC URL").fill(ANVIL_RPC);
await page.locator('//div[.//div[text()="Add RPC URL"]]//div[text()="Add"]').click();
await page.waitForTimeout(5000); // RPC probe fills the detected chain id
// The explorer field is required and must be https:// — no explorer exists for
// a throwaway local chain, so use a neutral placeholder.
await field("Block Explorer URL").fill("https://example.com");
await page.locator('//div[.//div[text()="Network details"]]//div[text()="Add network"]').click();
await page.getByText("Network successfully added!").waitFor({ timeout: 15000 });
await page.waitForTimeout(2000);

const dump = await sw.evaluate((keys) => chrome.storage.local.get(keys), FIXTURE_KEYS);
writeFileSync(FIXTURE, gzipSync(JSON.stringify(dump), { level: 9 }));
console.log(`wrote ${FIXTURE} with keys: ${Object.keys(dump).join(", ")}`);
await ctx.close();
