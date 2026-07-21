/**
 * Playwright e2e tests for wallet signing flows.
 *
 * Injects a mock wallet via EIP-6963 events + window.ethereum fallback,
 * navigates to connect/sign pages, clicks buttons, and verifies the API result.
 */

import { type BrowserContext, expect, test } from "@playwright/test";
import { createTestRequest, getBaseUrl, getTestResult, startServer, stopServer } from "./fixtures/test-server.mts";
import {
  getMockProviderScript,
  type MockWalletOptions,
  TEST_ADDRESS,
  TEST_CHAIN_ID,
  TEST_WALLET_NAME,
} from "./fixtures/mock-wallet.mts";

test.beforeAll(async () => {
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
});

async function walletContext(
  browser: import("@playwright/test").Browser,
  options?: MockWalletOptions,
): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(getMockProviderScript(TEST_ADDRESS, TEST_CHAIN_ID, options));
  return ctx;
}

/**
 * Simulate real popup close: window.close() aborts all in-flight fetch requests.
 * Without `await completeError(...)`, the POST is killed before it reaches the server.
 *
 * Uses route interception to add latency so the abort always wins the race
 * (on localhost the round-trip is <1ms, which makes the race non-deterministic).
 */
async function patchWindowClose(page: import("@playwright/test").Page) {
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

// --- Wallet Connection ---

test.describe("Wallet Connection", () => {
  test("connects successfully with mock wallet", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { chainId: TEST_CHAIN_ID });
    await page.goto(`${getBaseUrl()}/connect/${id}`);

    await expect(page.getByRole("heading", { name: "Connect Wallet" })).toBeVisible();
    await expect(page.getByText(TEST_WALLET_NAME)).toBeVisible();
    await expect(page.locator("img.wallet-icon")).toBeVisible();

    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(TEST_ADDRESS, { exact: false })).toBeVisible();

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
    expect(result?.result?.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());

    await ctx.close();
  });

  test("shows not-found for expired request", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    await page.goto(`${getBaseUrl()}/connect/00000000-0000-0000-0000-000000000000`);
    await expect(page.getByText("Request Not Found")).toBeVisible();

    await ctx.close();
  });

  test("shows error when no wallet is detected", async ({ browser }) => {
    const ctx = await browser.newContext(); // no mock wallet
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { chainId: TEST_CHAIN_ID });
    await page.goto(`${getBaseUrl()}/connect/${id}`);

    await expect(page.getByRole("heading", { name: "Connect Wallet" })).toBeVisible();
    await expect(page.locator("#connect-no-wallet")).toBeVisible();

    await ctx.close();
  });

  test("connects with matching required address", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", {
      chainId: TEST_CHAIN_ID,
      address: TEST_ADDRESS,
    });
    await page.goto(`${getBaseUrl()}/connect/${id}`);

    await expect(page.locator("#connect-required")).toBeVisible();
    // The Rust `Address` domain type normalizes to lowercase hex at the request boundary
    // (the UI matches addresses case-insensitively), so the rendered required-address is
    // lowercase rather than the checksummed input. Compare case-insensitively.
    await expect(page.locator("#connect-required-text")).toContainText(TEST_ADDRESS.toLowerCase());

    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
    expect(result?.result?.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());

    await ctx.close();
  });

  test("shows wrong address when required address does not match", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const wrongAddress = "0x0000000000000000000000000000000000000001";
    const { id } = await createTestRequest("connect", {
      chainId: TEST_CHAIN_ID,
      address: wrongAddress,
    });
    await page.goto(`${getBaseUrl()}/connect/${id}`);

    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.locator("#connect-wrong")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#connect-wrong-expected")).toHaveText(wrongAddress);
    await expect(page.locator("#connect-wrong-got")).toContainText(TEST_ADDRESS);

    // Verify the request is still pending (not completed with error)
    const result = await getTestResult(id);
    expect(result?.pending).toBe(true);

    await ctx.close();
  });

  test("cancels wallet connection", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { chainId: TEST_CHAIN_ID });
    await page.goto(`${getBaseUrl()}/connect/${id}`);

    await expect(page.getByRole("heading", { name: "Connect Wallet" })).toBeVisible();
    await patchWindowClose(page);

    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(200);

    const result = await getTestResult(id);
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("cancelled");

    await ctx.close();
  });

  test("auto-completes when wallet switches to correct address", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const wrongAddress = "0x0000000000000000000000000000000000000001";
    const { id } = await createTestRequest("connect", {
      chainId: TEST_CHAIN_ID,
      address: wrongAddress,
    });
    await page.goto(`${getBaseUrl()}/connect/${id}`);

    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.locator("#connect-wrong")).toBeVisible({ timeout: 10000 });

    // Simulate wallet emitting accountsChanged with the correct address
    await page.evaluate((addr) => {
      const provider = (window as any).ethereum;
      if (provider?._listeners?.accountsChanged) {
        for (const cb of provider._listeners.accountsChanged) {
          cb([addr]);
        }
      }
    }, wrongAddress);

    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
    expect(result?.result?.toLowerCase()).toBe(wrongAddress.toLowerCase());

    await ctx.close();
  });
});

// --- Transaction Signing ---

test.describe("Transaction Signing", () => {
  test("signs and sends transaction", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("send_transaction", {
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: "1000000000000000000",
      chainId: TEST_CHAIN_ID,
    });

    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByRole("heading", { name: "Send Transaction" })).toBeVisible();
    await expect(
      page.getByText("0x70997970C51812dc3A010C7d01b50e0d17dc79C8", { exact: false }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
    expect(result?.result).toMatch(/^0x[a-f0-9]+$/i);

    await ctx.close();
  });

  test("rejects transaction", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("send_transaction", {
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: "1000000000000000000",
      chainId: TEST_CHAIN_ID,
    });

    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByRole("heading", { name: "Send Transaction" })).toBeVisible();
    await patchWindowClose(page);

    await page.getByRole("button", { name: "Reject" }).click();
    await page.waitForTimeout(200);

    const result = await getTestResult(id);
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("rejected");

    await ctx.close();
  });
});

// --- Account Change Prompt ---
//
// A tx request whose `from` differs from the wallet's selected account must proactively open the
// wallet's account-change prompt (wallet_requestPermissions) after the Sign & Send click, and
// resume once the wallet switches. The mock's `requestPermissions` option scripts the user's
// answer to that prompt.

test.describe("Account Change Prompt", () => {
  // Anvil default account #2 — distinct from the mock's selected TEST_ADDRESS (account #0).
  const FROM_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

  function mismatchedTxRequest() {
    return createTestRequest("send_transaction", {
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: "1000000000000000000",
      chainId: TEST_CHAIN_ID,
      from: FROM_ADDRESS,
    });
  }

  test("lets the wallet run its own switch-account flow (Ambire-style)", async ({ browser }) => {
    // The page submits the mismatched operation as-is; the wallet opens its switch-account
    // confirmation, switches, and continues the tx — no permissions prompt is ever needed.
    const ctx = await walletContext(browser, { mismatchedFrom: "switch" });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

    const counts = await page.evaluate(() => ({
      perms: (window as any).ethereum._permissionRequestCount,
      tx: (window as any).ethereum._sendTxCount,
    }));
    expect(counts.perms).toBe(0);
    expect(counts.tx).toBe(1);

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);

    await ctx.close();
  });

  test("shows the wrong-address panel without re-prompting when the switch window is denied", async ({ browser }) => {
    // A denied switch-account window is an explicit user rejection (4001): land on the panel,
    // but do NOT immediately open another prompt at the user — the button stays available.
    const ctx = await walletContext(browser, {
      mismatchedFrom: "deny-switch",
      requestPermissions: { switchTo: FROM_ADDRESS },
    });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.locator("#tx-wrong")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#tx-change-btn")).toBeVisible();
    expect(await page.evaluate(() => (window as any).ethereum._permissionRequestCount)).toBe(0);

    const result = await getTestResult(id);
    expect(result?.pending).toBe(true);

    await ctx.close();
  });

  test("opens the prompt on mismatch and completes after approval", async ({ browser }) => {
    const ctx = await walletContext(browser, { requestPermissions: { switchTo: FROM_ADDRESS } });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

    const counts = await page.evaluate(() => ({
      perms: (window as any).ethereum._permissionRequestCount,
      tx: (window as any).ethereum._sendTxCount,
    }));
    expect(counts.perms).toBe(1);
    // The mock emits accountsChanged AND resolves the prompt for one approval; the page's
    // single-resume guard must collapse the two paths into exactly one broadcast.
    expect(counts.tx).toBe(1);

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);

    await ctx.close();
  });

  test("stays on the wrong-address panel when the prompt is rejected", async ({ browser }) => {
    const ctx = await walletContext(browser, { requestPermissions: "reject" });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.locator("#tx-wrong")).toBeVisible({ timeout: 10000 });

    // The rejected prompt is a recoverable, in-page error: the button re-arms for a retry and
    // the request stays pending (only an explicit Reject propagates to the caller).
    await expect(page.locator("#tx-change-btn")).toBeVisible();
    await expect(page.locator("#tx-change-btn")).toBeEnabled();
    await expect(page.locator("#tx-change-btn")).toHaveText("Change Account");

    const result = await getTestResult(id);
    expect(result?.pending).toBe(true);

    await ctx.close();
  });

  test("falls back to the passive account switch when the method is unsupported", async ({ browser }) => {
    const ctx = await walletContext(browser, { requestPermissions: "unsupported" });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.locator("#tx-wrong")).toBeVisible({ timeout: 10000 });
    // -32601 marks the wallet as incapable: no button, no re-prompt.
    await expect(page.locator("#tx-change-btn")).toBeHidden();

    // The user switches manually in the wallet UI; the accountsChanged listener resumes.
    await page.evaluate((addr) => (window as any).ethereum._switchAccount(addr), FROM_ADDRESS);
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);

    await ctx.close();
  });

  test("escalates to revoke + reconnect for wallets that resolve the prompt silently", async ({ browser }) => {
    // Ambire/Rabby/Brave answer wallet_requestPermissions from existing state without any UI;
    // the page must then revoke the permission and reconnect, which forces the wallet's connect
    // window (simulated here by eth_requestAccounts switching to `reconnectTo`).
    const ctx = await walletContext(browser, {
      requestPermissions: "silent",
      reconnectTo: FROM_ADDRESS,
    });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

    const counts = await page.evaluate(() => ({
      revokes: (window as any).ethereum._revokeCount,
      tx: (window as any).ethereum._sendTxCount,
    }));
    expect(counts.revokes).toBe(1);
    expect(counts.tx).toBe(1);

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);

    await ctx.close();
  });

  test("asks for a manual switch when the silent wallet also lacks revoke", async ({ browser }) => {
    // No reconnectTo → wallet_revokePermissions throws -32601: the wallet offers no
    // account-change UI at all, so the button disappears and the hint says to switch manually.
    const ctx = await walletContext(browser, { requestPermissions: "silent" });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.locator("#tx-wrong")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#tx-change-btn")).toBeHidden();
    await expect(page.locator("#tx-wrong-hint")).toHaveText(
      "Switch to the correct account in your wallet to continue.",
    );

    await page.evaluate((addr) => (window as any).ethereum._switchAccount(addr), FROM_ADDRESS);
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);

    await ctx.close();
  });

  test("Change Account button re-opens the prompt", async ({ browser }) => {
    const ctx = await walletContext(browser, { requestPermissions: "reject" });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.locator("#tx-wrong")).toBeVisible({ timeout: 10000 });
    await expect.poll(() => page.evaluate(() => (window as any).ethereum._permissionRequestCount)).toBe(1);

    await page.locator("#tx-change-btn").click();
    await expect.poll(() => page.evaluate(() => (window as any).ethereum._permissionRequestCount)).toBe(2);
    await expect(page.locator("#tx-wrong")).toBeVisible();

    const result = await getTestResult(id);
    expect(result?.pending).toBe(true);

    await ctx.close();
  });

  test("a late prompt approval after Reject never signs", async ({ browser }) => {
    const ctx = await walletContext(browser, {
      requestPermissions: { switchTo: FROM_ADDRESS, manual: true },
    });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.locator("#tx-wrong")).toBeVisible({ timeout: 10000 });
    // The prompt hangs open: the button reflects the in-flight state.
    await expect(page.locator("#tx-change-btn")).toHaveText("Check Wallet...");
    await expect(page.locator("#tx-change-btn")).toBeDisabled();

    await patchWindowClose(page);
    await page.getByRole("button", { name: "Reject" }).click();
    await page.waitForTimeout(200);

    const result = await getTestResult(id);
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("Wrong wallet address");

    // The wallet prompt cannot be revoked; the user approves it AFTER the rejection was
    // delivered. That must never re-run the flow (a broadcast here would be unobserved).
    await page.evaluate(() => (window as any).ethereum._approvePermissions());
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).ethereum._sendTxCount)).toBe(0);

    await ctx.close();
  });
});

// --- Message Signing ---

test.describe("Message Signing", () => {
  test("signs a message", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("sign_message", {
      message: "Hello, Ethereum!",
      chainId: TEST_CHAIN_ID,
    });

    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByRole("heading", { name: "Sign Message" })).toBeVisible();
    await expect(page.getByText("Hello, Ethereum!")).toBeVisible();

    await page.getByRole("button", { name: "Sign" }).click();
    await expect(page.getByText("Signed Successfully!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
    expect(result?.result).toMatch(/^0x[a-f0-9]+$/i);

    await ctx.close();
  });

  test("rejects message signing", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("sign_message", {
      message: "Hello, Ethereum!",
      chainId: TEST_CHAIN_ID,
    });

    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByRole("heading", { name: "Sign Message" })).toBeVisible();
    await patchWindowClose(page);

    await page.getByRole("button", { name: "Reject" }).click();
    await page.waitForTimeout(200);

    const result = await getTestResult(id);
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("rejected");

    await ctx.close();
  });

  test("signs EIP-712 typed data", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("sign_typed_data", {
      domain: { name: "Test App", version: "1", chainId: TEST_CHAIN_ID },
      types: { Message: [{ name: "content", type: "string" }] },
      primaryType: "Message",
      message: { content: "Hello, World!" },
      chainId: TEST_CHAIN_ID,
    });

    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByRole("heading", { name: "Sign Typed Data" })).toBeVisible();
    await expect(page.getByText("Typed Data (EIP-712)")).toBeVisible();

    await page.getByRole("button", { name: "Sign" }).click();
    await expect(page.getByText("Signed Successfully!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);

    await ctx.close();
  });

  test("rejects typed data signing", async ({ browser }) => {
    const ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("sign_typed_data", {
      domain: { name: "Test App", version: "1", chainId: TEST_CHAIN_ID },
      types: { Message: [{ name: "content", type: "string" }] },
      primaryType: "Message",
      message: { content: "Hello, World!" },
      chainId: TEST_CHAIN_ID,
    });

    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByRole("heading", { name: "Sign Typed Data" })).toBeVisible();
    await patchWindowClose(page);

    await page.getByRole("button", { name: "Reject" }).click();
    await page.waitForTimeout(200);

    const result = await getTestResult(id);
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("rejected");

    await ctx.close();
  });
});
