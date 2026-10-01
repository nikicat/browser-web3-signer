/**
 * Playwright e2e tests for wallet signing flows.
 *
 * Injects a mock wallet via EIP-6963 events + window.ethereum fallback,
 * navigates to connect/sign pages, clicks buttons, and verifies the API result.
 */

import { type BrowserContext, expect, test } from "@playwright/test";
import { createTestRequest, getBaseUrl, getTestResult, startServer, stopServer } from "./fixtures/test-server.mts";
import {
  addMockWallet,
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
  await addMockWallet(ctx, options);
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

// Anvil default account #2 — distinct from the mock's selected TEST_ADDRESS (account #0).
const OTHER_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function txRequest(extra: Record<string, unknown> = {}) {
  return createTestRequest("send_transaction", {
    to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    value: "1000000000000000000",
    chainId: TEST_CHAIN_ID,
    ...extra,
  });
}

// --- Wallet Connection ---

test.describe("Wallet Connection", () => {
  test("connects successfully with mock wallet", async ({ browser }) => {
    await using ctx = await walletContext(browser);
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
  });

  test("shows not-found for expired request", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    await page.goto(`${getBaseUrl()}/connect/00000000-0000-0000-0000-000000000000`);
    await expect(page.getByText("Request Not Found")).toBeVisible();
  });

  test("shows error when no wallet is detected", async ({ browser }) => {
    await using ctx = await browser.newContext(); // no mock wallet
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { chainId: TEST_CHAIN_ID });
    await page.goto(`${getBaseUrl()}/connect/${id}`);

    await expect(page.getByRole("heading", { name: "Connect Wallet" })).toBeVisible();
    await expect(page.locator("#connect-no-wallet")).toBeVisible();
  });

  test("connects with matching required address", async ({ browser }) => {
    await using ctx = await walletContext(browser);
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
  });

  test("shows wrong address when required address does not match", async ({ browser }) => {
    await using ctx = await walletContext(browser);
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
  });

  test("cancels wallet connection", async ({ browser }) => {
    await using ctx = await walletContext(browser);
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
  });

  test("auto-completes when wallet switches to correct address", async ({ browser }) => {
    await using ctx = await walletContext(browser);
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
    await page.evaluate((addr) => (window as any).ethereum._emit("accountsChanged", [addr]), wrongAddress);

    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
    expect(result?.result?.toLowerCase()).toBe(wrongAddress.toLowerCase());
  });
});

// --- Adding Unknown Chains ---

test.describe("Adding Unknown Chains", () => {
  const REGISTRY = "https://chainid.network/chains_mini.json";
  // Gnosis: in no built-in table, so only the registry can describe it.
  const GNOSIS = {
    name: "Gnosis",
    chainId: 100,
    nativeCurrency: { name: "xDAI", symbol: "XDAI", decimals: 18 },
    rpc: ["wss://rpc.gnosischain.com/wss", "https://gnosis.infura.io/v3/${INFURA_API_KEY}", "https://rpc.gnosischain.com"],
    explorers: [{ name: "gnosisscan", url: "https://gnosisscan.io" }],
  };

  /** Returns a wallet context whose wallet has a network only for chain 1. */
  function chain1Wallet(browser: import("@playwright/test").Browser) {
    return walletContext(browser, { knownChains: [TEST_CHAIN_ID] });
  }

  /** Returns a page that opened a connect request for `fields` and clicked Connect. */
  async function connectWithRegistry(
    ctx: BrowserContext,
    registry: Parameters<BrowserContext["route"]>[1],
    fields: Record<string, unknown>,
  ) {
    await ctx.route(REGISTRY, registry);
    const page = await ctx.newPage();
    const { id } = await createTestRequest("connect", fields);
    await page.goto(`${getBaseUrl()}/connect/${id}`);
    await page.getByRole("button", { name: "Connect" }).click();
    return page;
  }

  test("adds a chain the wallet lacks from the chain registry", async ({ browser }) => {
    await using ctx = await chain1Wallet(browser);
    const page = await connectWithRegistry(ctx, (route) => route.fulfill({ json: [GNOSIS] }), { chainId: 100 });
    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });

    // Only the plain https endpoint survives; currency and explorer come from the registry.
    expect(await page.evaluate(() => (window as any).ethereum._addedChains)).toEqual([
      {
        chainId: "0x64",
        chainName: "Gnosis",
        nativeCurrency: { name: "xDAI", symbol: "XDAI", decimals: 18 },
        rpcUrls: ["https://rpc.gnosischain.com"],
        blockExplorerUrls: ["https://gnosisscan.io"],
      },
    ]);
  });

  test("links to Chainlist when the registry is unreachable", async ({ browser }) => {
    await using ctx = await chain1Wallet(browser);
    const page = await connectWithRegistry(ctx, (route) => route.abort(), { chainId: 100 });

    await expect(page.locator("#connect-err")).toBeVisible({ timeout: 10000 });
    const link = page.getByRole("link", { name: "Add this network via Chainlist" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://chainlist.org/chain/100");
  });

  test("downloads the registry again on Try Again after a failure", async ({ browser }) => {
    let registryHits = 0;
    await using ctx = await chain1Wallet(browser);
    const page = await connectWithRegistry(
      ctx,
      (route) => (++registryHits === 1 ? route.abort() : route.fulfill({ json: [GNOSIS] })),
      { chainId: 100 },
    );
    await expect(page.locator("#connect-err")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Try Again" }).click();
    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });
    expect(registryHits).toBe(2);
  });

  test("clears the error once the wallet reaches the requested chain", async ({ browser }) => {
    await using ctx = await chain1Wallet(browser);
    await ctx.route(REGISTRY, (route) => route.abort());
    const page = await ctx.newPage();
    const { id } = await createTestRequest("sign_message", { message: "Hello, Gnosis!", chainId: 100 });
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await page.getByRole("button", { name: "Sign" }).click();
    await expect(page.locator("#msg-err")).toBeVisible({ timeout: 10000 });

    // The user adds the network in the wallet itself, which then switches to it.
    await page.evaluate((chain) => (window as any).ethereum.request({ method: "wallet_addEthereumChain", params: [chain] }), {
      chainId: "0x64",
      chainName: "Gnosis",
      nativeCurrency: GNOSIS.nativeCurrency,
      rpcUrls: ["https://rpc.gnosischain.com"],
    });
    await expect(page.locator("#msg-err")).toBeHidden();
    await expect(page.getByText("Hello, Gnosis!")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign" })).toBeEnabled();
  });

  test("prefers the request's rpcUrl over the built-in chain entry", async ({ browser }) => {
    let registryHits = 0;
    // Base (8453) is built in, but a caller pointing at its own node must win.
    await using ctx = await chain1Wallet(browser);
    const page = await connectWithRegistry(
      ctx,
      (route) => {
        registryHits++;
        return route.abort();
      },
      { chainId: 8453, rpcUrl: "http://127.0.0.1:8545/" },
    );
    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });

    const added = await page.evaluate(() => (window as any).ethereum._addedChains);
    expect(added).toHaveLength(1);
    expect(added[0].rpcUrls).toEqual(["http://127.0.0.1:8545/"]);
    expect(added[0].chainName).toBe("Base");
    expect(registryHits).toBe(0);
  });
});

// --- Shared page helpers (app-core.js) ---

test.describe("Core helpers", () => {
  test("onceUntilFailure shares one load and retries after a failure", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();
    const { id } = await createTestRequest("connect", { chainId: TEST_CHAIN_ID });
    await page.goto(`${getBaseUrl()}/connect/${id}`);

    const outcome = await page.evaluate(async () => {
      const { onceUntilFailure } = (window as any).WalletSignerCore;
      let calls = 0;
      const load = onceUntilFailure(() => (++calls === 1 ? Promise.reject(new Error("down")) : Promise.resolve(calls)));
      const failed = await Promise.allSettled([load(), load()]);
      const retried = await Promise.all([load(), load()]);
      const cached = await load();
      return { failed: failed.map((r) => r.status), retried, cached, calls };
    });
    // Concurrent callers share each attempt; the failure is retried once, the success kept.
    expect(outcome).toEqual({ failed: ["rejected", "rejected"], retried: [2, 2], cached: 2, calls: 2 });
  });
});

// --- Transaction Signing ---

test.describe("Transaction Signing", () => {
  test("signs and sends transaction", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await txRequest();

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
  });

  test("rejects transaction", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await txRequest();

    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.getByRole("heading", { name: "Send Transaction" })).toBeVisible();
    await patchWindowClose(page);

    await page.getByRole("button", { name: "Reject" }).click();
    await page.waitForTimeout(200);

    const result = await getTestResult(id);
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("rejected");
  });
});

// --- Account Change Prompt ---
//
// A tx request whose `from` differs from the wallet's selected account must proactively open the
// wallet's account-change prompt (wallet_requestPermissions) after the Sign & Send click, and
// resume once the wallet switches. The mock's `requestPermissions` option scripts the user's
// answer to that prompt.

test.describe("Account Change Prompt", () => {
  function mismatchedTxRequest() {
    return txRequest({ from: OTHER_ADDRESS });
  }

  test("lets the wallet run its own switch-account flow (Ambire-style)", async ({ browser }) => {
    // The page submits the mismatched operation as-is; the wallet opens its switch-account
    // confirmation, switches, and continues the tx — no permissions prompt is ever needed.
    await using ctx = await walletContext(browser, { mismatchedFrom: "switch" });
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
  });

  test("shows the wrong-address panel without re-prompting when the switch window is denied", async ({ browser }) => {
    // A denied switch-account window is an explicit user rejection (4001): land on the panel,
    // but do NOT immediately open another prompt at the user — the button stays available.
    await using ctx = await walletContext(browser, {
      mismatchedFrom: "deny-switch",
      requestPermissions: { switchTo: OTHER_ADDRESS },
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
  });

  test("opens the prompt on mismatch and completes after approval", async ({ browser }) => {
    await using ctx = await walletContext(browser, { requestPermissions: { switchTo: OTHER_ADDRESS } });
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
  });

  test("stays on the wrong-address panel when the prompt is rejected", async ({ browser }) => {
    await using ctx = await walletContext(browser, { requestPermissions: "reject" });
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
  });

  test("falls back to the passive account switch when the method is unsupported", async ({ browser }) => {
    await using ctx = await walletContext(browser, { requestPermissions: "unsupported" });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.locator("#tx-wrong")).toBeVisible({ timeout: 10000 });
    // -32601 marks the wallet as incapable: no button, no re-prompt.
    await expect(page.locator("#tx-change-btn")).toBeHidden();

    // The user switches manually in the wallet UI; the accountsChanged listener resumes.
    await page.evaluate((addr) => (window as any).ethereum._switchAccount(addr), OTHER_ADDRESS);
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
  });

  test("escalates to revoke + reconnect for wallets that resolve the prompt silently", async ({ browser }) => {
    // Ambire/Rabby/Brave answer wallet_requestPermissions from existing state without any UI;
    // the page must then revoke the permission and reconnect, which forces the wallet's connect
    // window (simulated here by eth_requestAccounts switching to `reconnectTo`).
    await using ctx = await walletContext(browser, {
      requestPermissions: "silent",
      reconnectTo: OTHER_ADDRESS,
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
  });

  test("asks for a manual switch when the silent wallet also lacks revoke", async ({ browser }) => {
    // No reconnectTo → wallet_revokePermissions throws -32601: the wallet offers no
    // account-change UI at all, so the button disappears and the hint says to switch manually.
    await using ctx = await walletContext(browser, { requestPermissions: "silent" });
    const page = await ctx.newPage();

    const { id } = await mismatchedTxRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.locator("#tx-wrong")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#tx-change-btn")).toBeHidden();
    await expect(page.locator("#tx-wrong-hint")).toHaveText(
      "Switch to the correct account in your wallet to continue.",
    );

    await page.evaluate((addr) => (window as any).ethereum._switchAccount(addr), OTHER_ADDRESS);
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });

    const result = await getTestResult(id);
    expect(result?.success).toBe(true);
  });

  test("Change Account button re-opens the prompt", async ({ browser }) => {
    await using ctx = await walletContext(browser, { requestPermissions: "reject" });
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
  });

  test("a late prompt approval after Reject never signs", async ({ browser }) => {
    await using ctx = await walletContext(browser, {
      requestPermissions: { switchTo: OTHER_ADDRESS, manual: true },
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
  });
});

// --- Account Switch ---
//
// A request that doesn't pin its signer signs with the wallet's selected account; the footer's
// Change link opens the wallet's account-change prompt so the user can pick another one first.

test.describe("Account Switch", () => {
  // The Connected: line for each account, as the page truncates it.
  const SHOWS_TEST = "Connected: 0xf39F...2266";
  const SHOWS_OTHER = "Connected: 0x3C44...93BC";

  test("sends the transaction from the account picked via Change", async ({ browser }) => {
    await using ctx = await walletContext(browser, { requestPermissions: { switchTo: OTHER_ADDRESS } });
    const page = await ctx.newPage();

    const { id } = await txRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.locator("#tx-connected")).toHaveText(SHOWS_TEST);

    await page.locator("#tx-switch-btn").click();
    await expect(page.locator("#tx-connected")).toHaveText(SHOWS_OTHER);

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() => (window as any).ethereum._sentFrom)).toEqual([OTHER_ADDRESS]);
    expect((await getTestResult(id))?.success).toBe(true);
  });

  test("signs a message from the account picked via revoke + reconnect", async ({ browser }) => {
    // Silent wallets (Ambire/Rabby) escalate to revoke + reconnect, as in the mismatch flow.
    await using ctx = await walletContext(browser, { requestPermissions: "silent", reconnectTo: OTHER_ADDRESS });
    const page = await ctx.newPage();

    const { id } = await createTestRequest("sign_message", { message: "hi", chainId: TEST_CHAIN_ID });
    await page.goto(`${getBaseUrl()}/sign/${id}`);

    await page.locator("#msg-switch-btn").click();
    await expect(page.locator("#msg-connected")).toHaveText(SHOWS_OTHER);
    expect(await page.evaluate(() => (window as any).ethereum._revokeCount)).toBe(1);

    await page.getByRole("button", { name: "Sign" }).click();
    await expect(page.getByText("Signed Successfully!")).toBeVisible({ timeout: 10000 });
    expect((await getTestResult(id))?.success).toBe(true);
  });

  test("follows an account switch made in the wallet", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await txRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.locator("#tx-connected")).toHaveText(SHOWS_TEST);

    await page.evaluate((addr) => (window as any).ethereum._switchAccount(addr), OTHER_ADDRESS);
    await expect(page.locator("#tx-connected")).toHaveText(SHOWS_OTHER);
  });

  test("keeps the prompt's rejection in-page", async ({ browser }) => {
    await using ctx = await walletContext(browser, { requestPermissions: "reject" });
    const page = await ctx.newPage();

    const { id } = await txRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await page.locator("#tx-switch-btn").click();

    await expect(page.locator("#tx-switch-btn")).toHaveText("Change");
    await expect(page.locator("#tx-connected")).toHaveText(SHOWS_TEST);
    expect(await getTestResult(id)).toEqual({ pending: true });
  });

  test("hides Change when the wallet has no account-change UI", async ({ browser }) => {
    await using ctx = await walletContext(browser, { requestPermissions: "unsupported" });
    const page = await ctx.newPage();

    const { id } = await txRequest();
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await page.locator("#tx-switch-btn").click();
    await expect(page.locator("#tx-switch-btn")).toBeHidden();
  });

  test("overrides a pinned signer with the picked account", async ({ browser }) => {
    // The caller pinned TEST_ADDRESS (viem pins the connected account on every request); the
    // user picks OTHER_ADDRESS instead, and the tx goes out from it.
    await using ctx = await walletContext(browser, { requestPermissions: { switchTo: OTHER_ADDRESS } });
    const page = await ctx.newPage();

    const { id } = await txRequest({ from: TEST_ADDRESS });
    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await page.locator("#tx-switch-btn").click();
    await expect(page.locator("#tx-connected")).toHaveText(SHOWS_OTHER);
    await expect(page.locator("#tx-required")).toContainText("overridden");

    await page.getByRole("button", { name: "Sign & Send" }).click();
    await expect(page.getByText("Transaction Sent!")).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate(() => (window as any).ethereum._sentFrom)).toEqual([OTHER_ADDRESS]);
  });

  test("connects the account picked on the connect page", async ({ browser }) => {
    await using ctx = await walletContext(browser, { requestPermissions: "silent", reconnectTo: OTHER_ADDRESS });
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { chainId: TEST_CHAIN_ID });
    await page.goto(`${getBaseUrl()}/connect/${id}`);
    await expect(page.locator("#connect-connected")).toHaveText("Selected: 0xf39F...2266");
    await page.locator("#connect-switch-btn").click();
    await expect(page.getByText("Connected!")).toBeVisible({ timeout: 10000 });
    expect((await getTestResult(id))?.result).toBe(OTHER_ADDRESS);
  });

  test("leaves a pinned connect to the wrong-address flow", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();

    const { id } = await createTestRequest("connect", { chainId: TEST_CHAIN_ID, address: TEST_ADDRESS });
    await page.goto(`${getBaseUrl()}/connect/${id}`);
    await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
    await expect(page.locator("#connect-switch-btn")).toBeHidden();
  });
});

// --- Message Signing ---

test.describe("Message Signing", () => {
  test("signs a message", async ({ browser }) => {
    await using ctx = await walletContext(browser);
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
  });

  test("rejects message signing", async ({ browser }) => {
    await using ctx = await walletContext(browser);
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
  });

  test("signs a { raw } message as its bytes, not its hex text", async ({ browser }) => {
    await using ctx = await walletContext(browser);
    const page = await ctx.newPage();
    const hash = "0x" + "ff".repeat(32);
    const { id } = await createTestRequest("sign_message", { message: { raw: hash }, chainId: TEST_CHAIN_ID });

    await page.goto(`${getBaseUrl()}/sign/${id}`);
    await expect(page.locator("#msg-label")).toHaveText("Raw bytes (hex)");
    await expect(page.locator("#msg-text")).toHaveText(hash);
    await page.getByRole("button", { name: "Sign" }).click();
    await expect(page.getByText("Signed Successfully!")).toBeVisible({ timeout: 10000 });

    expect(await page.evaluate(() => (window as any).ethereum._signedMessages)).toEqual([hash]);
    expect((await getTestResult(id))?.success).toBe(true);
  });

  test("signs EIP-712 typed data", async ({ browser }) => {
    await using ctx = await walletContext(browser);
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
  });

  test("rejects typed data signing", async ({ browser }) => {
    await using ctx = await walletContext(browser);
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
  });
});
