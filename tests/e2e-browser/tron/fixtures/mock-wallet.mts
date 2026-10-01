/**
 * Mock TronLink provider for Playwright e2e tests.
 *
 * TronLink injects two globals on page load:
 *   window.tronLink — has `request({method: "tron_requestAccounts"})` returning {code: 200|4001}
 *   window.tronWeb  — has defaultAddress.base58, fullNode.host, transactionBuilder.*, trx.*
 *
 * This mock fakes both with canned tx ids and signatures since we're testing UI flow,
 * not real chain submission.
 */

import type { BrowserContext } from "@playwright/test";

// A checksum-valid TRON Base58 address. (The upstream reference used a placeholder that does
// not pass Base58Check; the Rust `TronAddress` validates on construction, so any request that
// carries an `address` must use a real one. The mock-returned address takes the result path and
// isn't re-validated, but keeping this valid avoids surprises.)
export const TEST_ADDRESS = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
export const TEST_NETWORK = "mainnet";
export const TEST_NODE_HOST = "https://api.trongrid.io";

export const FAKE_TX_ID = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
export const FAKE_SIGNATURE = "0x" + "cd".repeat(65);
export const FAKE_TYPED_SIGNATURE = "0x" + "ef".repeat(65);

// The deploy flow reads contract_address from createSmartContract's result and converts it via
// tw.address.fromHex(). Both halves of that pair are mocked to canned values.
export const FAKE_CONTRACT_HEX = "41" + "ab".repeat(20);
export const FAKE_CONTRACT_BASE58 = "TDeployedMockContract000000000000XYZ";

export interface MockTronLinkOptions {
  address?: string;
  /** When true, requestAccounts returns {code: 4001} simulating user rejection. */
  rejectConnect?: boolean;
  /** When true, trx.sign throws — simulates the user clicking reject inside TronLink. */
  rejectSign?: boolean;
}

/** The mock's settings with every default resolved, as `installMockTronLink` receives them. */
interface MockTronLinkConfig {
  address: string;
  rejectConnect: boolean;
  rejectSign: boolean;
  nodeHost: string;
  fakes: {
    txId: string;
    signature: string;
    typedSignature: string;
    contractHex: string;
    contractBase58: string;
  };
}

/**
 * Installs mock `window.tronLink` and `window.tronWeb` in every page of `ctx` before the page's
 * own scripts run, so they are present before the page's `waitForTronWeb()` deadline starts.
 */
export function addMockTronLink(
  ctx: Pick<BrowserContext, "addInitScript">,
  options?: MockTronLinkOptions,
) {
  return ctx.addInitScript(installMockTronLink, {
    address: options?.address ?? TEST_ADDRESS,
    rejectConnect: options?.rejectConnect ?? false,
    rejectSign: options?.rejectSign ?? false,
    nodeHost: TEST_NODE_HOST,
    fakes: {
      txId: FAKE_TX_ID,
      signature: FAKE_SIGNATURE,
      typedSignature: FAKE_TYPED_SIGNATURE,
      contractHex: FAKE_CONTRACT_HEX,
      contractBase58: FAKE_CONTRACT_BASE58,
    },
  });
}

// Runs in the browser: Playwright ships it as source, so it may use only `cfg` and browser
// globals, never this module's imports or constants.
function installMockTronLink(cfg: MockTronLinkConfig) {
  const tronWeb = {
    defaultAddress: { base58: cfg.address, hex: "41" + "00".repeat(20), name: false },
    fullNode: { host: cfg.nodeHost },

    transactionBuilder: {
      async sendTrx(to: string, amount: number, from: string) {
        console.log("[MockTronWeb] sendTrx:", to, amount, from);
        return {
          txID: cfg.fakes.txId,
          raw_data: { contract: [{ type: "TransferContract", parameter: { value: { to_address: to, amount, owner_address: from } } }] },
          raw_data_hex: "deadbeef",
        };
      },
      async triggerSmartContract(contract: string, functionSelector: string, options: object, parameters: unknown[], from: string) {
        console.log("[MockTronWeb] triggerSmartContract:", contract, functionSelector, options, parameters, from);
        return {
          result: { result: true },
          transaction: {
            txID: cfg.fakes.txId,
            raw_data: {
              contract: [{
                type: "TriggerSmartContract",
                parameter: { value: { contract_address: contract, function_selector: functionSelector, parameter: parameters, owner_address: from } },
              }],
            },
            raw_data_hex: "deadbeef",
          },
        };
      },
      async createSmartContract(options: { name?: string; abi: unknown; bytecode: string }, ownerAddress: string) {
        console.log("[MockTronWeb] createSmartContract:", options && options.name, ownerAddress);
        return {
          txID: cfg.fakes.txId,
          contract_address: cfg.fakes.contractHex,
          raw_data: {
            contract: [{
              type: "CreateSmartContract",
              parameter: { value: { new_contract: { contract_address: cfg.fakes.contractHex, abi: options.abi, bytecode: options.bytecode } } },
            }],
          },
          raw_data_hex: "deadbeef",
        };
      },
    },

    address: {
      fromHex(hex: string) {
        console.log("[MockTronWeb] address.fromHex:", hex);
        // Real conversion isn't needed for UI tests — return our canned Base58 value.
        return cfg.fakes.contractBase58;
      },
    },

    trx: {
      async sign(unsignedTx: { txID: string }) {
        console.log("[MockTronWeb] sign:", unsignedTx && unsignedTx.txID);
        if (cfg.rejectSign) throw new Error("User rejected the transaction");
        return Object.assign({}, unsignedTx, { signature: ["fake-signature-hex"] });
      },
      async sendRawTransaction(signedTx: { txID: string }) {
        console.log("[MockTronWeb] sendRawTransaction:", signedTx && signedTx.txID);
        return { result: true, transaction: signedTx, txid: signedTx.txID };
      },
      async signMessageV2(message: string) {
        console.log("[MockTronWeb] signMessageV2:", message);
        if (cfg.rejectSign) throw new Error("User rejected message signing");
        return cfg.fakes.signature;
      },
      async _signTypedData(domain: object, types: object, message: object) {
        console.log("[MockTronWeb] _signTypedData:", JSON.stringify({domain, types, message}));
        if (cfg.rejectSign) throw new Error("User rejected typed-data signing");
        return cfg.fakes.typedSignature;
      },
    },
  };

  const tronLink = {
    ready: true,
    tronWeb: tronWeb,
    async request({ method }: { method: string }) {
      console.log("[MockTronLink] request:", method);
      if (method === "tron_requestAccounts") {
        if (cfg.rejectConnect) return { code: 4001, message: "User rejected" };
        return { code: 200, message: "ok" };
      }
      return { code: 4200, message: "Method not supported: " + method };
    },
  };

  (window as any).tronLink = tronLink;
  (window as any).tronWeb = tronWeb;

  console.log("[MockTronLink] Injected at " + cfg.address);
}
