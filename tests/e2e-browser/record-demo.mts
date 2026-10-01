/**
 * Records the README demo video: drives the real approval-page UI (connect +
 * send-transaction) against the Rust evm-harness with the mock wallet, at
 * human pace, with a fake cursor overlay (Playwright video has no cursor).
 *
 * Run: node record-demo.mts   (node >= 22.6; needs `just e2e-build` + chromium)
 * Output: demo-video/<hash>.webm — convert to GIF with ffmpeg (see docs PR).
 */

import { chromium, type Page } from "@playwright/test";
import { addFakeCursor, CURSOR_DOT } from "./fixtures/fake-cursor.mts";
import { makeHarness } from "./fixtures/harness.mts";
import { addMockWallet, TEST_CHAIN_ID } from "./evm/fixtures/mock-wallet.mts";

// The mock wallet returns a recognizably fake tx hash (0xabab…); rewrite it to a
// realistic-looking one so the demo's success screen reads plausibly.
const DEMO_TX_HASH = "0x8f3c2a5b9e1d47c6a0f5b82d4e91c37a6d508b4f2c19e7d3a85f60b1c4d92e7a";

// Runs in the page: Playwright ships it as source, so it may use only its argument and
// browser globals.
/** Makes every provider the page sees answer `eth_sendTransaction` with `txHash`. */
function installTxHashPatch(txHash: string) {
  const patch = (p: any) => {
    if (!p || p.__demoPatched) return;
    p.__demoPatched = true;
    const orig = p.request.bind(p);
    p.request = async (args: { method: string }) => {
      const r = await orig(args);
      return args && args.method === "eth_sendTransaction" ? txHash : r;
    };
  };
  patch((window as any).ethereum);
  window.addEventListener("eip6963:announceProvider", (e) => patch((e as CustomEvent).detail?.provider));
}

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
await addMockWallet(ctx, { name: "Demo Wallet", rdns: "dev.demo.wallet" });
await ctx.addInitScript(installTxHashPatch, DEMO_TX_HASH);
await addFakeCursor(ctx, CURSOR_DOT);
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
