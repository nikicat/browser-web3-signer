/**
 * Mock wallet provider for Playwright e2e tests.
 *
 * Generates a script that creates a mock wallet in the browser,
 * announcing it via EIP-6963 events and setting window.ethereum as fallback.
 * The mock returns fake signatures/hashes since we're testing UI flow.
 */

// Test account (Anvil default account #0)
export const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const TEST_CHAIN_ID = 1;

// EIP-6963 identity
export const TEST_WALLET_NAME = "MockWallet";
export const TEST_WALLET_RDNS = "test.mockwallet";

export interface MockWalletOptions {
  name?: string;
  rdns?: string;
  /**
   * Behavior of `wallet_requestPermissions` (the wallet's account-change prompt):
   * - `{ switchTo }` — the user approves: switch the wallet to that account (emitting
   *   `accountsChanged` synchronously before resolving, mirroring MetaMask's ordering) and
   *   resolve with an EIP-2255 permission object. With `manual: true` the prompt instead hangs
   *   until the test calls `window.ethereum._approvePermissions()`.
   * - `"silent"` — resolve immediately with the existing permission and NO UI, the
   *   Ambire/Rabby/Brave behavior.
   * - `"reject"` — the user dismisses the prompt: throw EIP-1193 code 4001.
   * - `"unsupported"` — a wallet without the method: throw code -32601.
   * - absent — legacy default: the method is unhandled and throws a plain Error.
   */
  requestPermissions?: { switchTo: string; manual?: boolean } | "silent" | "reject" | "unsupported";
  /**
   * When set, `wallet_revokePermissions` is supported (MIP-2): it disconnects the origin, and
   * the next `eth_requestAccounts` "opens the connect window" where the user picks this
   * account. When unset, `wallet_revokePermissions` throws -32601.
   */
  reconnectTo?: string;
  /**
   * Behavior of a signing operation (`eth_sendTransaction`, `personal_sign`,
   * `eth_signTypedData_v4`) whose `from`/address doesn't match the selected account:
   * - `"reject"` (default) — MetaMask-style: throw 4100 unauthorized (Rabby throws -32602; same
   *   shape for the page's purposes).
   * - `"switch"` — Ambire-style: the user approves the wallet's own switch-account window; the
   *   account switches (emitting `accountsChanged`) and the operation continues as it.
   * - `"deny-switch"` — Ambire-style switch window denied by the user: throw 4001.
   */
  mismatchedFrom?: "reject" | "switch" | "deny-switch";
}

/**
 * Generate the mock provider script to inject into the browser.
 *
 * Sets up both:
 * 1. EIP-6963 announcements (primary — mipd store picks these up)
 * 2. window.ethereum fallback (legacy path)
 */
export function getMockProviderScript(
  address: string,
  chainId: number,
  options?: MockWalletOptions,
): string {
  const name = options?.name ?? TEST_WALLET_NAME;
  const rdns = options?.rdns ?? TEST_WALLET_RDNS;
  const requestPermissions = options?.requestPermissions ?? null;
  const reconnectTo = options?.reconnectTo ?? null;
  const mismatchedFrom = options?.mismatchedFrom ?? "reject";

  return `
(function() {
  const TEST_ADDRESS = "${address}";
  const TEST_CHAIN_ID = ${chainId};
  const WALLET_NAME = "${name}";
  const WALLET_RDNS = "${rdns}";
  const REQUEST_PERMISSIONS = ${JSON.stringify(requestPermissions)};
  const RECONNECT_TO = ${JSON.stringify(reconnectTo)};
  const MISMATCHED_FROM = ${JSON.stringify(mismatchedFrom)};

  // Mutable selected account: the approval page re-reads eth_accounts after an account change,
  // so a switch must actually stick, not just be announced.
  let currentAddress = TEST_ADDRESS;
  // Whether the origin holds the eth_accounts permission (wallet_revokePermissions clears it).
  let permitted = true;

  function toHex(num) {
    return "0x" + num.toString(16);
  }

  function fakeHash(prefix) {
    return "0x" + prefix.repeat(32);
  }

  function fakeSignature(prefix) {
    return "0x" + prefix.repeat(65);
  }

  // Build an SVG icon as data URI
  const WALLET_ICON = "data:image/svg+xml;base64," + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect fill="#6366f1" width="32" height="32" rx="6"/></svg>'
  );

  // A signing operation for another account: real wallets never silently sign with the wrong
  // one — they run a switch flow (Ambire) or reject (MetaMask 4100 / Rabby -32602).
  function requireAuthorized(addr) {
    if (!addr || addr.toLowerCase() === currentAddress.toLowerCase()) return;
    console.log("[MockWallet] mismatched from " + addr + " -> " + MISMATCHED_FROM);
    if (MISMATCHED_FROM === "switch") {
      provider._switchAccount(addr);
      return;
    }
    if (MISMATCHED_FROM === "deny-switch") {
      throw { code: 4001, message: "User rejected the request." };
    }
    throw { code: 4100, message: "The requested account and/or method has not been authorized by the user." };
  }

  // EIP-2255 permission object for the currently permitted account.
  function grantedPermissions() {
    return [{
      parentCapability: "eth_accounts",
      caveats: [{ type: "restrictReturnedAccounts", value: [currentAddress] }],
    }];
  }

  const handlers = {
    eth_requestAccounts: async () => {
      if (!permitted) {
        // "The connect window opens": the user picks RECONNECT_TO and reconnects.
        permitted = true;
        provider._switchAccount(RECONNECT_TO);
      }
      console.log("[MockWallet] eth_requestAccounts -> " + currentAddress);
      return [currentAddress];
    },
    eth_accounts: async () => {
      const accounts = permitted ? [currentAddress] : [];
      console.log("[MockWallet] eth_accounts -> " + JSON.stringify(accounts));
      return accounts;
    },
    wallet_requestPermissions: async (params) => {
      provider._permissionRequestCount++;
      console.log("[MockWallet] wallet_requestPermissions:", JSON.stringify(params));
      if (REQUEST_PERMISSIONS === null) {
        // Legacy default: behave like a wallet without the method, minus a proper error code.
        throw new Error("Method not supported: wallet_requestPermissions");
      }
      if (REQUEST_PERMISSIONS === "silent") {
        // The Ambire/Rabby behavior: resolve from existing state, never show UI.
        return grantedPermissions();
      }
      if (REQUEST_PERMISSIONS === "reject") {
        throw { code: 4001, message: "User rejected the request." };
      }
      if (REQUEST_PERMISSIONS === "unsupported") {
        throw { code: -32601, message: "Method not found" };
      }
      if (REQUEST_PERMISSIONS.manual) {
        // Hang until the test approves: window.ethereum._approvePermissions().
        return new Promise((resolve) => {
          provider._approvePermissions = () => {
            provider._switchAccount(REQUEST_PERMISSIONS.switchTo);
            resolve(grantedPermissions());
          };
        });
      }
      // Emit accountsChanged synchronously BEFORE resolving — MetaMask's ordering — so both
      // resume paths (listener + promise) fire and the page's single-resume guard is exercised.
      provider._switchAccount(REQUEST_PERMISSIONS.switchTo);
      return grantedPermissions();
    },
    wallet_revokePermissions: async (params) => {
      provider._revokeCount++;
      console.log("[MockWallet] wallet_revokePermissions:", JSON.stringify(params));
      if (!RECONNECT_TO) throw { code: -32601, message: "Method not found" };
      permitted = false;
      const cbs = provider._listeners?.accountsChanged ?? [];
      for (const cb of [...cbs]) cb([]);
      return null;
    },
    eth_chainId: async () => {
      const hex = toHex(TEST_CHAIN_ID);
      console.log("[MockWallet] eth_chainId -> " + hex);
      return hex;
    },
    wallet_switchEthereumChain: async (params) => {
      console.log("[MockWallet] wallet_switchEthereumChain:", params);
      return null;
    },
    wallet_addEthereumChain: async (params) => {
      console.log("[MockWallet] wallet_addEthereumChain:", params);
      return null;
    },
    eth_sendTransaction: async (params) => {
      const tx = params[0];
      console.log("[MockWallet] eth_sendTransaction:", tx);
      requireAuthorized(tx.from);
      provider._sendTxCount++;
      const hash = fakeHash("ab");
      return hash;
    },
    personal_sign: async (params) => {
      console.log("[MockWallet] personal_sign:", params);
      requireAuthorized(params[1]);
      const sig = fakeSignature("cd");
      return sig;
    },
    eth_signTypedData_v4: async (params) => {
      console.log("[MockWallet] eth_signTypedData_v4:", params);
      requireAuthorized(params[0]);
      const sig = fakeSignature("ef");
      return sig;
    },
    eth_getBalance: async () => "0x8AC7230489E80000",
    eth_estimateGas: async () => "0x5208",
    eth_gasPrice: async () => "0x3B9ACA00",
    net_version: async () => String(TEST_CHAIN_ID),
  };

  // Build the EIP-1193 provider object
  const provider = {
    _isMockProvider: true,
    _sendTxCount: 0,
    _permissionRequestCount: 0,
    _revokeCount: 0,
    selectedAddress: TEST_ADDRESS,
    chainId: toHex(TEST_CHAIN_ID),
    networkVersion: String(TEST_CHAIN_ID),

    // Test hook: switch the selected account and emit accountsChanged, like a user switching
    // in the wallet UI.
    _switchAccount: (addr) => {
      currentAddress = addr;
      provider.selectedAddress = addr;
      const cbs = provider._listeners?.accountsChanged ?? [];
      for (const cb of [...cbs]) cb([addr]);
    },

    request: async ({ method, params }) => {
      console.log("[MockWallet] request:", method);
      const handler = handlers[method];
      if (handler) {
        try {
          return await handler(params || []);
        } catch (err) {
          console.error("[MockWallet] Error:", method, err);
          throw err;
        }
      }
      console.warn("[MockWallet] Unhandled:", method);
      throw new Error("Method not supported: " + method);
    },

    on: (event, cb) => {
      if (!provider._listeners) provider._listeners = {};
      if (!provider._listeners[event]) provider._listeners[event] = [];
      provider._listeners[event].push(cb);
    },

    removeListener: (event, cb) => {
      if (provider._listeners?.[event]) {
        const idx = provider._listeners[event].indexOf(cb);
        if (idx !== -1) provider._listeners[event].splice(idx, 1);
      }
    },

    _listeners: {},

    enable: async () => [currentAddress],
  };

  // Legacy fallback — set window.ethereum (no isMetaMask flag so we can
  // verify the name comes from EIP-6963, not from the legacy detection).
  window.ethereum = provider;

  // --- EIP-6963 wallet announcement ---
  const providerDetail = Object.freeze({
    info: Object.freeze({
      uuid: crypto.randomUUID(),
      name: WALLET_NAME,
      icon: WALLET_ICON,
      rdns: WALLET_RDNS,
    }),
    provider: provider,
  });

  function announceProvider() {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: providerDetail,
      })
    );
  }

  // Announce immediately so any store already listening picks it up
  announceProvider();

  // Re-announce whenever a dapp requests providers
  window.addEventListener("eip6963:requestProvider", () => {
    console.log("[MockWallet] Received eip6963:requestProvider, re-announcing...");
    announceProvider();
  });

  console.log("[MockWallet] Injected " + WALLET_NAME + " at " + TEST_ADDRESS + " (EIP-6963 + legacy)");
})();
`;
}
