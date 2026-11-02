/**
 * Playwright e2e tests for Bitcoin wallet signing flows.
 *
 * Injects a mock Unisat provider (window.unisat) via addInitScript, navigates to connect/sign
 * pages, clicks buttons, and verifies both what the page asked the wallet for and the result
 * the bridge received.
 */

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createTestRequest, getBaseUrl, getTestResult, startServer, stopServer } from "./fixtures/test-server.mts";
import {
  addMockUnisat,
  FAKE_SIGNATURE,
  FAKE_TXID,
  MAINNET_ADDRESS,
  type MockUnisatOptions,
  PSBT_HEX,
  PSBT_TXID,
  SIGNET_ADDRESS,
  unisatCalls,
} from "./fixtures/mock-wallet.mts";

test.beforeAll(async () => {
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
});

async function walletContext(browser: Browser, options?: MockUnisatOptions): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await addMockUnisat(ctx, options);
  return ctx;
}

/** Make window.close() abort in-flight fetches, as a real popup close does (see the TRON spec). */
async function patchWindowClose(page: Page) {
  await page.route("**/api/complete/**", async (route) => {
    await new Promise((r) => setTimeout(r, 100));
    try {
      await route.continue();
    } catch {
      /* request was aborted by the browser */
    }
  });
  await page.evaluate(() => {
    const controller = new AbortController();
    const origFetch = window.fetch;
    window.fetch = (input, init?) => origFetch(input, { ...init, signal: controller.signal });
    window.close = () => controller.abort();
  });
}

async function methods(page: Page): Promise<string[]> {
  return (await unisatCalls(page)).map((c) => c.method);
}

test.describe("Wallet Connection", () => {
  test("connects on mainnet without switching chains", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { network: "mainnet" });
    await page.goto(`${getBaseUrl()}/connect/${id}`);
    await expect(page.getByRole("heading", { name: "Connect Bitcoin Wallet" })).toBeVisible();
    await expect(page.locator("#connect-chain")).toHaveText("Bitcoin Mainnet");

    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });

    expect(await methods(page)).toEqual(["requestAccounts"]);
    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
    expect(result?.result).toBe(MAINNET_ADDRESS);
  });

  test("switches the wallet to the request's chain before reading the address", async ({ browser }) => {
    await using ctx = await walletContext(browser); // wallet starts on mainnet
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { network: "signet" });
    await page.goto(`${getBaseUrl()}/connect/${id}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });

    // The switch must come first: on mainnet the account's address is the bc1… one.
    expect(await methods(page)).toEqual(["switchChain", "requestAccounts"]);
    expect((await unisatCalls(page))[0].args).toEqual(["BITCOIN_SIGNET"]);
    expect((await getTestResult(id))?.result).toBe(SIGNET_ADDRESS);
  });

  test("shows error when no Unisat is detected", async ({ browser }) => {
    await using ctx = await browser.newContext(); // no mock wallet
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { network: "mainnet" });
    await page.goto(`${getBaseUrl()}/connect/${id}`);
    await expect(page.locator("#connect-no-wallet")).toBeVisible();
  });

  test("shows wrong address when the required address does not match", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const other = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
    const { id } = await createTestRequest("connect", { network: "mainnet", address: other });
    await page.goto(`${getBaseUrl()}/connect/${id}`);
    await page.getByRole("button", { name: "Connect" }).click();

    await expect(page.locator("#connect-wrong")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#connect-wrong-expected")).toHaveText(other);
    await expect(page.locator("#connect-wrong-got")).toContainText(MAINNET_ADDRESS);
    expect((await getTestResult(id))?.pending).toBe(true);
  });

  test("matches a required bech32 address case-insensitively", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    // The bridge canonicalizes to lowercase; the wallet answering in uppercase still matches.
    await page.addInitScript((upper) => {
      const orig = (window as any).unisat.requestAccounts;
      (window as any).unisat.requestAccounts = async () => (await orig()) && [upper];
    }, MAINNET_ADDRESS.toUpperCase());
    const { id } = await createTestRequest("connect", { network: "mainnet", address: MAINNET_ADDRESS });
    await page.goto(`${getBaseUrl()}/connect/${id}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });
  });

  test("cancels wallet connection", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { network: "mainnet" });
    await page.goto(`${getBaseUrl()}/connect/${id}`);
    await expect(page.locator("#connect-idle")).toBeVisible();
    await patchWindowClose(page);
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(200);

    const result = await getTestResult(id);
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("cancelled");
  });
});

test.describe("Send Bitcoin", () => {
  test("sends with sendBitcoin, passing sats and the fee rate", async ({ browser }) => {
    await using ctx = await walletContext(browser, { chain: "BITCOIN_SIGNET" });
    const page = await ctx.newPage();

    const { id } = await createTestRequest("send_transfer", {
      network: "signet",
      to: SIGNET_ADDRESS,
      amount: "150000",
      feeRate: "3",
    });
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByRole("heading", { name: "Send Bitcoin" })).toBeVisible();
    await expect(page.locator("#tx-value")).toHaveText("0.0015 BTC");
    await expect(page.locator("#tx-fee")).toHaveText("3 sat/vB");
    await expect(page.locator("#tx-network")).toHaveText("Bitcoin Signet");

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

    const send = (await unisatCalls(page)).find((c) => c.method === "sendBitcoin");
    expect(send?.args).toEqual([SIGNET_ADDRESS, 150000, { feeRate: 3 }]);
    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
    expect(result?.result).toBe(FAKE_TXID);
  });

  test("shows a wallet rejection in-page and lets the user reject", async ({ browser }) => {
    await using ctx = await walletContext(browser, { rejectSign: true });
    const page = await ctx.newPage();

    const { id } = await createTestRequest("send_transfer", {
      network: "mainnet",
      to: MAINNET_ADDRESS,
      amount: "1000",
    });
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.locator("#tx-err")).toBeVisible({ timeout: 10000 });
    expect((await getTestResult(id))?.pending).toBe(true);

    await patchWindowClose(page);
    await page.getByRole("button", { name: "Reject" }).click();
    await page.waitForTimeout(200);

    const result = await getTestResult(id);
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("rejected");
  });
});

test.describe("Sign PSBT", () => {
  test("signs without broadcasting and returns the PSBT", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("sign_psbt", {
      network: "mainnet",
      psbt: PSBT_HEX,
      signInputs: [0],
    });
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByRole("heading", { name: "Sign PSBT" })).toBeVisible();
    await expect(page.locator("#tx-inputs")).toHaveText("0");
    await expect(page.locator("#tx-broadcast")).toHaveText("return unfinalized");

    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.getByText("PSBT Signed!")).toBeVisible({ timeout: 10000 });

    const sign = (await unisatCalls(page)).find((c) => c.method === "signPsbt");
    expect(sign?.args).toEqual([
      PSBT_HEX,
      { autoFinalized: false, toSignInputs: [{ index: 0, address: MAINNET_ADDRESS }] },
    ]);
    expect(await methods(page)).not.toContain("pushPsbt");
    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
    expect(JSON.parse(result!.result!)).toEqual({ psbt: PSBT_HEX });
  });

  test("broadcasts with pushPsbt and returns the txid", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("sign_psbt", {
      network: "mainnet",
      psbt: PSBT_HEX,
      broadcast: true,
    });
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.locator("#tx-broadcast")).toHaveText("finalize and broadcast");
    await page.getByRole("button", { name: "Sign & Broadcast" }).click();
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#tx-hash")).toHaveText(PSBT_TXID);

    const sign = (await unisatCalls(page)).find((c) => c.method === "signPsbt");
    // No signInputs: Unisat signs every input the account owns.
    expect(sign?.args).toEqual([PSBT_HEX, { autoFinalized: true }]);
    expect(await methods(page)).toContain("pushPsbt");
    expect(JSON.parse((await getTestResult(id))!.result!)).toEqual({ psbt: PSBT_HEX, txid: PSBT_TXID });
  });
});

test.describe("Message Signing", () => {
  test("signs with BIP-322 by default", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("sign_message", { network: "mainnet", message: "Hello Bitcoin" });
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByText("Hello Bitcoin")).toBeVisible();
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.getByText("Signed Successfully!")).toBeVisible({ timeout: 10000 });

    const sign = (await unisatCalls(page)).find((c) => c.method === "signMessage");
    expect(sign?.args).toEqual(["Hello Bitcoin", "bip322-simple"]);
    expect((await getTestResult(id))?.result).toBe(FAKE_SIGNATURE);
  });

  test("signs with ECDSA when asked", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("sign_message", {
      network: "mainnet",
      message: "legacy",
      protocol: "ecdsa",
    });
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await expect(page.getByText("Signed Successfully!")).toBeVisible({ timeout: 10000 });

    const sign = (await unisatCalls(page)).find((c) => c.method === "signMessage");
    expect(sign?.args).toEqual(["legacy", "ecdsa"]);
  });
});
