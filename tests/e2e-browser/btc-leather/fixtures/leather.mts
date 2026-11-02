/**
 * Launches the real Leather extension (a `build:test` dist, path in LEATHER_EXT_DIR) in a
 * persistent Chromium context, signed in to the test wallet on the e2e regtest network, and
 * drives its approval popups. Headless works: Leather's own suite runs it that way.
 */

import { type BrowserContext, chromium, expect, type Locator, type Page } from "@playwright/test";
import { TEST_ENCRYPTION_KEY, walletState } from "./leather-state.mts";

export interface Leather {
  context: BrowserContext;
  extensionId: string;
  close(): Promise<void>;
}

/** The built extension, or null when it isn't available (the spec then skips). */
export function leatherExtDir(): string | null {
  return process.env.LEATHER_EXT_DIR || null;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * Leather's hosted API, answered locally for the few endpoints its screens wait on even on a
 * custom network: fee rates and prices (the send screen shows both), plus its own per-address
 * UTXO and history lookups (empty: on regtest those come from the Esplora shim). Shapes follow
 * Leather's own test mocks (`tests/mocks/mock-leather-api.ts`). Regtest has no fee market, so
 * fees quote the relay minimum and up.
 */
function leatherApiAnswer(path: string): object | null {
  if (path.endsWith("/v1/market/bitcoin/fees")) return { low: { rate: 1 }, standard: { rate: 2 }, high: { rate: 3 } };
  if (path.endsWith("/v1/market/prices/native")) return { format: "map", data: { BTC: { price: 45000, change24h: 0 }, STX: { price: 1, change24h: 0 } } };
  if (path.endsWith("/v1/market/fiat-rates")) return { rates: { EUR: 0.85 } };
  if (path.includes("/v1/utxos/addresses/")) return [];
  if (path.includes("/v1/transactions/bitcoin/addresses/")) return { meta: { page: 1, pageSize: 1, totalPages: 1, totalItems: 0 }, data: [] };
  return null;
}

export async function launchLeather(extDir: string, esploraUrl: string): Promise<Leather> {
  const context = await chromium.launchPersistentContext("", {
    headless: true,
    channel: "chromium",
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  // Hermetic: everything but the local bridge and Esplora shim is refused, as in Leather's own
  // `mockUnhandledRequests` (prices, analytics, feature flags, Leather's hosted API).
  // Each refused endpoint is logged once, so a popup stuck waiting on one names it.
  const refused = new Set<string>();
  await context.route(/.*/, (route) => {
    const url = new URL(route.request().url());
    if (!url.protocol.startsWith("http") || LOCAL_HOSTS.has(url.hostname)) return route.continue();
    const canned = leatherApiAnswer(url.pathname);
    if (canned) return route.fulfill({ json: canned });
    const endpoint = url.origin + url.pathname;
    if (process.env.LEATHER_E2E_DEBUG && !refused.has(endpoint)) {
      refused.add(endpoint);
      console.error(`[leather] refused ${route.request().method()} ${endpoint}`);
    }
    return route.abort();
  });

  if (process.env.LEATHER_E2E_DEBUG) {
    context.on("page", (p) =>
      p.on("console", (msg) => {
        if (msg.type() === "error" || msg.type() === "warning") console.error(`[leather ${msg.type()}] ${msg.text().slice(0, 300)}`);
      }),
    );
  }

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;

  // Seed the signed-in state, then load the app so it rehydrates from it; retry like Leather's
  // seedWalletStateAndWaitFor, since a fresh profile can race its own initial write.
  const page = context.pages()[0] ?? (await context.newPage());
  const home = `chrome-extension://${extensionId}/index.html`;
  for (let attempt = 0; ; attempt++) {
    await page.goto(home);
    await page.evaluate(
      async ([state, key]) => {
        await chrome.storage.local.set({ "persist:root": state });
        await chrome.storage.session.set({ encryptionKey: key });
      },
      [walletState(esploraUrl), TEST_ENCRYPTION_KEY] as const,
    );
    await page.goto(home);
    try {
      await expect(page.getByTestId("tab-tokens")).toBeVisible({ timeout: 10000 });
      break;
    } catch (err) {
      if (attempt >= 2) throw new Error(`Leather did not sign in with the seeded state: ${err}`);
    }
  }

  return {
    context,
    extensionId,
    async close() {
      await context.close();
    },
  };
}

const isPopup = (leather: Leather) => (p: Page) =>
  !p.isClosed() && p.url().startsWith(`chrome-extension://${leather.extensionId}/popup`);

/** The newest open Leather popup window, waiting for one if none is open. */
export async function nextPopup(leather: Leather, timeout = 20000): Promise<Page> {
  const open = leather.context.pages().filter(isPopup(leather));
  if (open.length) return open[open.length - 1];
  return leather.context.waitForEvent("page", { predicate: isPopup(leather), timeout });
}

/** Close popups left over from an earlier operation, so the next one is unambiguous. */
export async function closePopups(leather: Leather): Promise<void> {
  await Promise.all(leather.context.pages().filter(isPopup(leather)).map((p) => p.close()));
}

/** A Leather popup action: the control it waits for, and what it does once that's there. */
export interface PopupAction {
  control(popup: Page): Locator;
  run(popup: Page): Promise<void>;
}

const accountApproval = (popup: Page) => popup.getByTestId("get-addresses-approve-button");

/**
 * Handle Leather's popups for one operation. A sign page first calls getAddresses (the page holds
 * no address yet), and Leather may ask to connect the origin again before showing the operation's
 * own popup; such a popup can also close itself mid-click once Leather answers on its own. So:
 * wait for either the account approval or the action's control, approve accounts as often as
 * asked, and run the action when its control shows up.
 */
export async function approve(leather: Leather, action: PopupAction): Promise<void> {
  for (let popups = 0; popups < 5; popups++) {
    const popup = await nextPopup(leather);
    const accounts = accountApproval(popup);
    const wanted = action === approveAccounts ? accounts : action.control(popup);
    try {
      await accounts.or(wanted).first().waitFor({ timeout: 20000 });
    } catch (err) {
      if (popup.isClosed()) continue; // Leather answered by itself and closed it
      throw err;
    }
    if (action !== approveAccounts && (await accounts.isVisible())) {
      await accounts.click({ timeout: 5000 }).catch(() => {}); // may close itself first
      if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 10000 }).catch(() => {});
      continue;
    }
    return action.run(popup);
  }
  throw new Error("Leather kept asking for account approval; the operation's popup never came");
}

export const approveAccounts: PopupAction = {
  control: accountApproval,
  run: (popup) => accountApproval(popup).click(),
};
export const approveTransfer: PopupAction = {
  control: (popup) => popup.getByRole("button", { name: /^(Approve|Sign transaction)$/ }),
  async run(popup) {
    await this.control(popup).click();
    // Spending Taproot coins asks for one more confirmation.
    await popup.getByText("I understand, continue", { exact: true }).click({ timeout: 3000 }).catch(() => {});
  },
};
export const approvePsbt: PopupAction = {
  control: (popup) => popup.getByText("Confirm", { exact: true }),
  run: (popup) => popup.getByText("Confirm", { exact: true }).click(),
};
export const approveMessage: PopupAction = {
  control: (popup) => popup.getByText("Sign", { exact: true }),
  run: (popup) => popup.getByText("Sign", { exact: true }).click(),
};
export const cancel: PopupAction = {
  control: (popup) => popup.getByText("Cancel", { exact: true }),
  run: (popup) => popup.getByText("Cancel", { exact: true }).click(),
};
