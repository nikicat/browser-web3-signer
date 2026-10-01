/**
 * The EIP-1193 wallet the e2e tests and the demo recorder put in front of the approval page:
 * found over EIP-6963 or `window.ethereum`, it answers with canned hashes and signatures, since
 * what is under test is the page's flow, not a chain.
 */

import type { BrowserContext } from "@playwright/test";

// Test account (Anvil default account #0)
export const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const TEST_CHAIN_ID = 1;

// EIP-6963 identity
export const TEST_WALLET_NAME = "MockWallet";
export const TEST_WALLET_RDNS = "test.mockwallet";

export interface MockWalletOptions {
  /** The selected account; `TEST_ADDRESS` when unset. */
  address?: string;
  /** The active chain; `TEST_CHAIN_ID` when unset. */
  chainId?: number;
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
  /**
   * The chain ids the wallet has networks for: a switch to any other throws EIP-3085 code 4902
   * until `wallet_addEthereumChain` adds it (params kept in `window.ethereum._addedChains`).
   * Unset: every switch and add succeeds without changing chains.
   */
  knownChains?: number[];
}

/** The mock's settings with every default resolved, as `installMockWallet` receives them. */
interface MockWalletConfig {
  address: string;
  chainId: number;
  name: string;
  rdns: string;
  requestPermissions: NonNullable<MockWalletOptions["requestPermissions"]> | null;
  reconnectTo: string | null;
  mismatchedFrom: NonNullable<MockWalletOptions["mismatchedFrom"]>;
  knownChains: number[] | null;
}

/** Installs the mock wallet in every page of `ctx`, ahead of the page's own scripts. */
export function addMockWallet(ctx: Pick<BrowserContext, "addInitScript">, options?: MockWalletOptions) {
  return ctx.addInitScript(installMockWallet, {
    address: options?.address ?? TEST_ADDRESS,
    chainId: options?.chainId ?? TEST_CHAIN_ID,
    name: options?.name ?? TEST_WALLET_NAME,
    rdns: options?.rdns ?? TEST_WALLET_RDNS,
    requestPermissions: options?.requestPermissions ?? null,
    reconnectTo: options?.reconnectTo ?? null,
    mismatchedFrom: options?.mismatchedFrom ?? "reject",
    knownChains: options?.knownChains ?? null,
  });
}

// Runs in the browser: Playwright ships it as source, so it may use only `cfg` and browser
// globals, never this module's imports or constants.
function installMockWallet(cfg: MockWalletConfig) {
  type Listener = (...args: any[]) => void;
  type Handlers = Record<string, (params: any[]) => Promise<unknown>>;

  // Mutable selected account: the approval page re-reads eth_accounts after an account change,
  // so a switch must actually stick, not just be announced.
  let currentAddress = cfg.address;
  // Whether the origin holds the eth_accounts permission (wallet_revokePermissions clears it).
  let permitted = true;
  let currentChainId = cfg.chainId;

  const provider = makeProvider({
    ...accountHandlers(),
    ...chainHandlers(),
    ...signingHandlers(),
    eth_getBalance: async () => "0x8AC7230489E80000",
    eth_estimateGas: async () => "0x5208",
    eth_gasPrice: async () => "0x3B9ACA00",
    net_version: async () => String(cfg.chainId),
  });
  // Legacy fallback — no isMetaMask flag, so tests can verify the name comes from EIP-6963.
  (window as any).ethereum = provider;
  announceOverEip6963();
  console.log("[MockWallet] Injected " + cfg.name + " at " + cfg.address + " (EIP-6963 + legacy)");

  function toHex(num: number) {
    return "0x" + num.toString(16);
  }

  // EIP-2255 permission object for the currently permitted account.
  function grantedPermissions() {
    return [{
      parentCapability: "eth_accounts",
      caveats: [{ type: "restrictReturnedAccounts", value: [currentAddress] }],
    }];
  }

  /** Returns the handlers for connecting and for account and permission changes. */
  function accountHandlers(): Handlers {
    const prompt = cfg.requestPermissions;
    return {
      eth_requestAccounts: async () => {
        if (!permitted) {
          // "The connect window opens": the user picks cfg.reconnectTo and reconnects.
          permitted = true;
          provider._switchAccount(cfg.reconnectTo);
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
        if (prompt === null) {
          // Legacy default: behave like a wallet without the method, minus a proper error code.
          throw new Error("Method not supported: wallet_requestPermissions");
        }
        if (prompt === "silent") {
          // The Ambire/Rabby behavior: resolve from existing state, never show UI.
          return grantedPermissions();
        }
        if (prompt === "reject") {
          throw { code: 4001, message: "User rejected the request." };
        }
        if (prompt === "unsupported") {
          throw { code: -32601, message: "Method not found" };
        }
        if (prompt.manual) {
          // Hang until the test approves: window.ethereum._approvePermissions().
          return new Promise((resolve) => {
            provider._approvePermissions = () => {
              provider._switchAccount(prompt.switchTo);
              resolve(grantedPermissions());
            };
          });
        }
        // Emit accountsChanged synchronously BEFORE resolving — MetaMask's ordering — so both
        // resume paths (listener + promise) fire and the page's single-resume guard is exercised.
        provider._switchAccount(prompt.switchTo);
        return grantedPermissions();
      },
      wallet_revokePermissions: async (params) => {
        provider._revokeCount++;
        console.log("[MockWallet] wallet_revokePermissions:", JSON.stringify(params));
        if (!cfg.reconnectTo) throw { code: -32601, message: "Method not found" };
        permitted = false;
        provider._emit("accountsChanged", []);
        return null;
      },
    };
  }

  /** Returns the handlers for reading, switching and adding networks. */
  function chainHandlers(): Handlers {
    const known = cfg.knownChains;
    return {
      eth_chainId: async () => {
        const hex = toHex(currentChainId);
        console.log("[MockWallet] eth_chainId -> " + hex);
        return hex;
      },
      wallet_switchEthereumChain: async (params) => {
        console.log("[MockWallet] wallet_switchEthereumChain:", params);
        if (known) {
          const id = parseInt(params[0].chainId, 16);
          if (!known.includes(id)) throw { code: 4902, message: "Unrecognized chain ID " + params[0].chainId };
          setChain(id);
        }
        return null;
      },
      wallet_addEthereumChain: async (params) => {
        console.log("[MockWallet] wallet_addEthereumChain:", params);
        if (known) {
          const id = parseInt(params[0].chainId, 16);
          provider._addedChains.push(params[0]);
          known.push(id);
          setChain(id);
        }
        return null;
      },
    };
  }

  /** Makes `id` the active chain and announces it as EIP-1193 `chainChanged`, as wallets do. */
  function setChain(id: number) {
    if (id === currentChainId) return;
    currentChainId = id;
    provider._emit("chainChanged", toHex(id));
  }

  /** Returns the handlers that sign or send, with canned hashes and signatures. */
  function signingHandlers(): Handlers {
    return {
      eth_sendTransaction: async (params) => {
        const tx = params[0];
        console.log("[MockWallet] eth_sendTransaction:", tx);
        requireAuthorized(tx.from);
        provider._sendTxCount++;
        return "0x" + "ab".repeat(32);
      },
      personal_sign: async (params) => {
        console.log("[MockWallet] personal_sign:", params);
        requireAuthorized(params[1]);
        return "0x" + "cd".repeat(65);
      },
      eth_signTypedData_v4: async (params) => {
        console.log("[MockWallet] eth_signTypedData_v4:", params);
        requireAuthorized(params[0]);
        return "0x" + "ef".repeat(65);
      },
    };
  }

  // A signing operation for another account: real wallets never silently sign with the wrong
  // one — they run a switch flow (Ambire) or reject (MetaMask 4100 / Rabby -32602).
  function requireAuthorized(addr: string | undefined) {
    if (!addr || addr.toLowerCase() === currentAddress.toLowerCase()) return;
    console.log("[MockWallet] mismatched from " + addr + " -> " + cfg.mismatchedFrom);
    if (cfg.mismatchedFrom === "switch") {
      provider._switchAccount(addr);
      return;
    }
    if (cfg.mismatchedFrom === "deny-switch") {
      throw { code: 4001, message: "User rejected the request." };
    }
    throw { code: 4100, message: "The requested account and/or method has not been authorized by the user." };
  }

  /** Returns an EIP-1193 provider answering from `handlers`, plus the `_`-prefixed test hooks. */
  function makeProvider(handlers: Handlers): any {
    const listeners: Record<string, Listener[]> = {};
    const p: any = {
      _isMockProvider: true,
      _sendTxCount: 0,
      _permissionRequestCount: 0,
      _revokeCount: 0,
      _addedChains: [],
      selectedAddress: cfg.address,
      chainId: toHex(cfg.chainId),
      networkVersion: String(cfg.chainId),

      // Test hook: switch the selected account and emit accountsChanged, like a user switching
      // in the wallet UI.
      _switchAccount: (addr: string) => {
        currentAddress = addr;
        p.selectedAddress = addr;
        p._emit("accountsChanged", [addr]);
      },

      request: async ({ method, params }: { method: string; params?: any[] }) => {
        console.log("[MockWallet] request:", method);
        const handler = handlers[method];
        if (!handler) {
          console.warn("[MockWallet] Unhandled:", method);
          throw new Error("Method not supported: " + method);
        }
        try {
          return await handler(params || []);
        } catch (err) {
          console.error("[MockWallet] Error:", method, err);
          throw err;
        }
      },

      on: (event: string, cb: Listener) => {
        (listeners[event] ??= []).push(cb);
      },
      removeListener: (event: string, cb: Listener) => {
        const idx = listeners[event]?.indexOf(cb) ?? -1;
        if (idx !== -1) listeners[event].splice(idx, 1);
      },
      // Copies the list first: a listener may unsubscribe itself while being called.
      _emit: (event: string, ...args: unknown[]) => {
        for (const cb of [...(listeners[event] ?? [])]) cb(...args);
      },

      enable: async () => [currentAddress],
    };
    return p;
  }

  /** Announces the provider now and again on every EIP-6963 request from the page. */
  function announceOverEip6963() {
    const icon = "data:image/svg+xml;base64," + btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect fill="#6366f1" width="32" height="32" rx="6"/></svg>'
    );
    const detail = Object.freeze({
      info: Object.freeze({ uuid: crypto.randomUUID(), name: cfg.name, icon, rdns: cfg.rdns }),
      provider,
    });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    announce();
    window.addEventListener("eip6963:requestProvider", () => {
      console.log("[MockWallet] Received eip6963:requestProvider, re-announcing...");
      announce();
    });
  }
}
