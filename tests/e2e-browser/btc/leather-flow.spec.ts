/**
 * Playwright e2e tests for the Bitcoin page's Leather driver, against a mock
 * `window.LeatherProvider` (the real extension is driven by `btc-leather/`). Checks what the page
 * asks Leather for — method, params, network — and the result the bridge receives.
 */

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createTestRequest, getBaseUrl, getTestResult, startServer, stopServer } from "./fixtures/test-server.mts";
import {
  addMockLeather,
  FAKE_SIGNATURE,
  FAKE_TXID,
  LEATHER_SEGWIT_ADDRESS,
  LEATHER_TAPROOT_ADDRESS,
  leatherCalls,
  type MockLeatherOptions,
  PSBT_HEX,
  PSBT_TXID,
} from "./fixtures/mock-wallet.mts";

test.beforeAll(async () => {
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
});

async function walletContext(browser: Browser, options?: MockLeatherOptions): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await addMockLeather(ctx, options);
  return ctx;
}

async function call(page: Page, method: string) {
  return (await leatherCalls(page)).find((c) => c.method === method);
}

test("connects and returns the payment (native segwit) address", async ({ browser }) => {
  await using ctx = await walletContext(browser);
  const page = await ctx.newPage();

  const { id } = await createTestRequest("connect", { network: "regtest" });
  await page.goto(`${getBaseUrl()}/connect/${id}`);
  await expect(page.locator("#connect-wname")).toHaveText("Leather");
  await expect(page.locator("#connect-chain")).toHaveText("Bitcoin Regtest");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });

  expect((await call(page, "getAddresses"))?.params).toEqual({ network: "regtest" });
  expect((await getTestResult(id))?.result).toBe(LEATHER_SEGWIT_ADDRESS);
});

test("connects to the Taproot address when that's the one required", async ({ browser }) => {
  await using ctx = await walletContext(browser);
  const page = await ctx.newPage();

  const { id } = await createTestRequest("connect", { network: "regtest", address: LEATHER_TAPROOT_ADDRESS });
  await page.goto(`${getBaseUrl()}/connect/${id}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });
  expect((await getTestResult(id))?.result).toBe(LEATHER_TAPROOT_ADDRESS);
});

test("sends with sendTransfer, naming the network", async ({ browser }) => {
  await using ctx = await walletContext(browser);
  const page = await ctx.newPage();

  const { id } = await createTestRequest("send_transfer", {
    network: "regtest",
    to: LEATHER_TAPROOT_ADDRESS,
    amount: "25000",
    feeRate: "5",
  });
  await page.goto(`${getBaseUrl()}/sign/${id}`);
  await page.getByRole("button", { name: "Sign & Send" }).click();
  await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

  // No fee rate: Leather's sendTransfer has no such parameter.
  expect((await call(page, "sendTransfer"))?.params).toEqual({
    recipients: [{ address: LEATHER_TAPROOT_ADDRESS, amount: "25000" }],
    network: "regtest",
  });
  expect((await getTestResult(id))?.result).toBe(FAKE_TXID);
});

test("signs a PSBT at the requested inputs without broadcasting", async ({ browser }) => {
  await using ctx = await walletContext(browser);
  const page = await ctx.newPage();

  const { id } = await createTestRequest("sign_psbt", { network: "regtest", psbt: PSBT_HEX, signInputs: [0] });
  await page.goto(`${getBaseUrl()}/sign/${id}`);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.getByText("PSBT Signed!")).toBeVisible({ timeout: 10000 });

  expect((await call(page, "signPsbt"))?.params).toEqual({
    hex: PSBT_HEX,
    broadcast: false,
    network: "regtest",
    signAtIndex: [0],
  });
  expect(JSON.parse((await getTestResult(id))!.result!)).toEqual({ psbt: PSBT_HEX });
});

test("signs and broadcasts a PSBT", async ({ browser }) => {
  await using ctx = await walletContext(browser);
  const page = await ctx.newPage();

  const { id } = await createTestRequest("sign_psbt", { network: "regtest", psbt: PSBT_HEX, broadcast: true });
  await page.goto(`${getBaseUrl()}/sign/${id}`);
  await page.getByRole("button", { name: "Sign & Broadcast" }).click();
  await expect(page.locator("#tx-hash")).toHaveText(PSBT_TXID, { timeout: 10000 });
  expect(JSON.parse((await getTestResult(id))!.result!)).toEqual({ psbt: PSBT_HEX, txid: PSBT_TXID });
});

test("refuses finalize-without-broadcast in-page, since Leather can't do it", async ({ browser }) => {
  await using ctx = await walletContext(browser);
  const page = await ctx.newPage();

  const { id } = await createTestRequest("sign_psbt", { network: "regtest", psbt: PSBT_HEX, finalize: true });
  await page.goto(`${getBaseUrl()}/sign/${id}`);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("#tx-err-msg")).toContainText("can't finalize", { timeout: 10000 });
  expect(await call(page, "signPsbt")).toBeUndefined();
  expect((await getTestResult(id))?.pending).toBe(true);
});

test("signs a message with the Taproot address as a legacy signature", async ({ browser }) => {
  await using ctx = await walletContext(browser);
  const page = await ctx.newPage();

  const { id } = await createTestRequest("sign_message", {
    network: "regtest",
    message: "hi",
    address: LEATHER_TAPROOT_ADDRESS,
    protocol: "ecdsa",
  });
  await page.goto(`${getBaseUrl()}/sign/${id}`);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.getByText("Signed Successfully!")).toBeVisible({ timeout: 10000 });

  expect((await call(page, "signMessage"))?.params).toEqual({
    message: "hi",
    paymentType: "p2tr",
    type: "legacy",
    network: "regtest",
  });
  expect((await getTestResult(id))?.result).toBe(FAKE_SIGNATURE);
});

test("shows a Leather rejection in-page and keeps the request pending", async ({ browser }) => {
  await using ctx = await walletContext(browser, { rejectSign: true });
  const page = await ctx.newPage();

  const { id } = await createTestRequest("sign_message", { network: "regtest", message: "no" });
  await page.goto(`${getBaseUrl()}/sign/${id}`);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(page.locator("#msg-err-msg")).toContainText("User rejected", { timeout: 10000 });
  expect((await getTestResult(id))?.pending).toBe(true);
});
