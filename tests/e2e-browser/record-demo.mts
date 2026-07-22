/**
 * Records the README demo video: drives the real approval-page UI (connect +
 * send-transaction) against the Rust evm-harness with the mock wallet, at
 * human pace, with a fake cursor overlay (Playwright video has no cursor).
 *
 * Run: node record-demo.mts   (node >= 22.6; needs `just e2e-build` + chromium)
 * Output: demo-video/<hash>.webm — convert to GIF with ffmpeg (see docs PR).
 */

import { chromium, type Page } from "@playwright/test";
import { makeHarness } from "./fixtures/harness.mts";
import { getMockProviderScript, TEST_ADDRESS, TEST_CHAIN_ID } from "./evm/fixtures/mock-wallet.mts";

const CURSOR_SCRIPT = `
window.addEventListener("DOMContentLoaded", () => {
  const dot = document.createElement("div");
  dot.style.cssText =
    "position:fixed;z-index:99999;width:18px;height:18px;border-radius:50%;" +
    "background:rgba(30,30,30,.55);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);" +
    "pointer-events:none;transform:translate(-50%,-50%);left:-40px;top:-40px;" +
    "transition:width .12s,height .12s";
  document.body.appendChild(dot);
  window.addEventListener("mousemove", (e) => {
    dot.style.left = e.clientX + "px";
    dot.style.top = e.clientY + "px";
  }, true);
  window.addEventListener("mousedown", () => { dot.style.width = "26px"; dot.style.height = "26px"; }, true);
  window.addEventListener("mouseup", () => { dot.style.width = "18px"; dot.style.height = "18px"; }, true);
});
`;

// The mock wallet returns a recognizably fake tx hash (0xabab…); rewrite it to a
// realistic-looking one so the demo's success screen reads plausibly.
const DEMO_TX_HASH = "0x8f3c2a5b9e1d47c6a0f5b82d4e91c37a6d508b4f2c19e7d3a85f60b1c4d92e7a";
const HASH_PATCH_SCRIPT = `
(function () {
  const patch = (p) => {
    if (!p || p.__demoPatched) return;
    p.__demoPatched = true;
    const orig = p.request.bind(p);
    p.request = async (args) => {
      const r = await orig(args);
      return args && args.method === "eth_sendTransaction" ? "${DEMO_TX_HASH}" : r;
    };
  };
  patch(window.ethereum);
  window.addEventListener("eip6963:announceProvider", (e) => patch(e.detail && e.detail.provider));
})();
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function glideAndClick(page: Page, name: string): Promise<void> {
  const box = await page.getByRole("button", { name }).boundingBox();
  if (!box) throw new Error(`button "${name}" has no bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 30 });
  await sleep(400);
  await page.mouse.down();
  await sleep(120);
  await page.mouse.up();
}

const harness = makeHarness("evm-harness");
await harness.startServer();

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 900, height: 620 },
  recordVideo: { dir: "demo-video", size: { width: 900, height: 620 } },
});
await ctx.addInitScript(
  getMockProviderScript(TEST_ADDRESS, TEST_CHAIN_ID, { name: "Demo Wallet", rdns: "dev.demo.wallet" }),
);
await ctx.addInitScript(HASH_PATCH_SCRIPT);
await ctx.addInitScript(CURSOR_SCRIPT);
const page = await ctx.newPage();
const video = page.video();

// Scene 1: connect
const connect = await harness.createTestRequest("connect", { chainId: TEST_CHAIN_ID });
await page.goto(`${harness.getBaseUrl()}/connect/${connect.id}`);
await page.getByRole("heading", { name: "Connect Wallet" }).waitFor();
await page.mouse.move(450, 80); // seed the cursor overlay into view
await sleep(1600);
await glideAndClick(page, "Connect");
await page.getByText("Connected!").waitFor({ timeout: 10000 });
await sleep(2000);

// Scene 2: send a transaction
const tx = await harness.createTestRequest("send_transaction", {
  to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  value: "1000000000000000000",
  chainId: TEST_CHAIN_ID,
});
await page.goto(`${harness.getBaseUrl()}/sign/${tx.id}`);
await page.getByRole("heading", { name: "Send Transaction" }).waitFor();
await page.mouse.move(450, 80);
await sleep(3200); // let the viewer read the request details
await glideAndClick(page, "Sign & Send");
await page.getByText("Transaction Sent!").waitFor({ timeout: 10000 });
await sleep(2000);

await ctx.close();
console.log(`video: ${await video?.path()}`);
await browser.close();
await harness.stopServer();
