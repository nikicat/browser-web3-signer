/**
 * Mock Unisat provider (`window.unisat`) for Playwright e2e tests.
 *
 * Models the parts of Unisat's page provider the adapter uses (see
 * `docs/adr/0001-bitcoin-support.md`): one address per chain, `getChain`/`switchChain` (which
 * changes the address, as the real wallet does), `sendBitcoin`, `signPsbt`, `pushPsbt`,
 * `signMessage`, and `accountsChanged`/`networkChanged` events. Every call is recorded in
 * `window.__unisatCalls` so specs can assert what the page asked for.
 */

import type { BrowserContext, Page } from "@playwright/test";

export const MAINNET_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
export const SIGNET_ADDRESS = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

/** A one-input, one-output PSBT (rust-bitcoin's test vectors) and its unsigned txid. */
export const PSBT_HEX =
  "70736274ff01003f0200000001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000000ffffffff010000000000000000036a010000000000000a0f0102030405060708090f0102030405060708090a0b0c0d0e0f0000";
export const PSBT_TXID = "75c5c9665a570569ad77dd1279e6fd4628a093c4dcbf8d41532614044c14c115";

export const FAKE_TXID = "ab".repeat(32);
export const FAKE_SIGNATURE = "AkcwRAIgZmFrZS1zaWduYXR1cmU=";

export type UnisatChain = "BITCOIN_MAINNET" | "BITCOIN_TESTNET" | "BITCOIN_TESTNET4" | "BITCOIN_SIGNET";

export interface MockUnisatOptions {
  /** The chain the wallet starts on. Default mainnet. */
  chain?: UnisatChain;
  /** Throw from signing calls, as when the user rejects in the wallet. */
  rejectSign?: boolean;
}

interface MockUnisatConfig {
  chain: UnisatChain;
  rejectSign: boolean;
  addresses: { mainnet: string; test: string };
  fakes: { txid: string; signature: string; psbtTxid: string };
}

export function addMockUnisat(ctx: Pick<BrowserContext, "addInitScript">, options?: MockUnisatOptions) {
  return ctx.addInitScript(installMockUnisat, {
    chain: options?.chain ?? "BITCOIN_MAINNET",
    rejectSign: options?.rejectSign ?? false,
    addresses: { mainnet: MAINNET_ADDRESS, test: SIGNET_ADDRESS },
    fakes: { txid: FAKE_TXID, signature: FAKE_SIGNATURE, psbtTxid: PSBT_TXID },
  });
}

/** The calls the page made to the mock, in order. */
export function unisatCalls(page: Page): Promise<{ method: string; args: unknown[] }[]> {
  return page.evaluate(() => (window as any).__unisatCalls);
}

// Runs in the browser: Playwright ships it as source, so it may use only `cfg` and browser
// globals, never this module's imports or constants.
function installMockUnisat(cfg: MockUnisatConfig) {
  let chain = cfg.chain;
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  const calls: { method: string; args: unknown[] }[] = [];
  (window as any).__unisatCalls = calls;

  const address = () => (chain === "BITCOIN_MAINNET" ? cfg.addresses.mainnet : cfg.addresses.test);
  const emit = (event: string, arg: unknown) => (listeners[event] || []).forEach((fn) => fn(arg));
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
    console.log("[MockUnisat]", method, JSON.stringify(args));
  };
  const maybeReject = (what: string) => {
    if (cfg.rejectSign) throw Object.assign(new Error("User rejected the " + what), { code: 4001 });
  };

  (window as any).unisat = {
    on(event: string, fn: (arg: unknown) => void) {
      (listeners[event] ||= []).push(fn);
    },
    removeListener(event: string, fn: (arg: unknown) => void) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
    async getChain() {
      return { enum: chain, name: chain, network: chain === "BITCOIN_MAINNET" ? "livenet" : "testnet" };
    },
    async switchChain(next: UnisatChain) {
      record("switchChain", next);
      chain = next;
      emit("networkChanged", chain === "BITCOIN_MAINNET" ? "livenet" : "testnet");
      emit("accountsChanged", [address()]);
      return { enum: chain };
    },
    async getAccounts() {
      return [address()];
    },
    async requestAccounts() {
      record("requestAccounts");
      return [address()];
    },
    async sendBitcoin(to: string, sats: number, options?: { feeRate?: number }) {
      record("sendBitcoin", to, sats, options);
      maybeReject("transfer");
      return cfg.fakes.txid;
    },
    async signPsbt(psbtHex: string, options?: unknown) {
      record("signPsbt", psbtHex, options);
      maybeReject("PSBT");
      return psbtHex;
    },
    async pushPsbt(psbtHex: string) {
      record("pushPsbt", psbtHex);
      return cfg.fakes.psbtTxid;
    },
    async signMessage(text: string, type: string) {
      record("signMessage", text, type);
      maybeReject("message");
      return cfg.fakes.signature;
    },
  };
  console.log("[MockUnisat] Injected on " + chain);
}

// --- Leather ---

export const LEATHER_SEGWIT_ADDRESS = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
export const LEATHER_TAPROOT_ADDRESS = "bcrt1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqc8gma6";

export interface MockLeatherOptions {
  /** Reject signing calls with Leather's user-rejection error. */
  rejectSign?: boolean;
}

interface MockLeatherConfig {
  rejectSign: boolean;
  segwit: string;
  taproot: string;
  fakes: { txid: string; signature: string; psbtTxid: string };
}

/**
 * Mock Leather provider (`window.LeatherProvider`): the JSON-RPC `request(method, params)` shape
 * of `@leather.io/provider` (resolves `{jsonrpc, id, result}`, rejects `{jsonrpc, id, error}`),
 * with one native-segwit and one Taproot address. Calls are recorded in `window.__leatherCalls`.
 */
export function addMockLeather(ctx: Pick<BrowserContext, "addInitScript">, options?: MockLeatherOptions) {
  return ctx.addInitScript(installMockLeather, {
    rejectSign: options?.rejectSign ?? false,
    segwit: LEATHER_SEGWIT_ADDRESS,
    taproot: LEATHER_TAPROOT_ADDRESS,
    fakes: { txid: FAKE_TXID, signature: FAKE_SIGNATURE, psbtTxid: PSBT_TXID },
  });
}

export function leatherCalls(page: Page): Promise<{ method: string; params: any }[]> {
  return page.evaluate(() => (window as any).__leatherCalls);
}

// Runs in the browser: may use only `cfg` and browser globals.
function installMockLeather(cfg: MockLeatherConfig) {
  const calls: { method: string; params: unknown }[] = [];
  (window as any).__leatherCalls = calls;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: "1", result });
  const rejection = { jsonrpc: "2.0", id: "1", error: { code: 4001, message: "User rejected request" } };

  (window as any).LeatherProvider = {
    isLeather: true,
    async request(method: string, params: any) {
      calls.push({ method, params });
      console.log("[MockLeather]", method, JSON.stringify(params));
      if (method === "getAddresses") {
        return ok({
          addresses: [
            { symbol: "BTC", type: "p2wpkh", address: cfg.segwit, publicKey: "02" + "11".repeat(32) },
            { symbol: "BTC", type: "p2tr", address: cfg.taproot, publicKey: "03" + "22".repeat(32) },
            { symbol: "STX", address: "ST000000000000000000002AMW42H", publicKey: "03" + "33".repeat(32) },
          ],
        });
      }
      if (cfg.rejectSign) throw rejection;
      if (method === "sendTransfer") return ok({ txid: cfg.fakes.txid });
      if (method === "signPsbt") return ok(params.broadcast ? { hex: params.hex, txid: cfg.fakes.psbtTxid } : { hex: params.hex });
      if (method === "signMessage") return ok({ signature: cfg.fakes.signature, address: cfg.segwit, message: params.message });
      throw { jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Method not found: " + method } };
    },
  };
  console.log("[MockLeather] Injected");
}
