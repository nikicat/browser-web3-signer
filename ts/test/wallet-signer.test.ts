/**
 * Integration tests for the TS binding against the real Rust `serve` subprocess.
 *
 * A fake-wallet script (passed as `--browser`) stands in for the browser+wallet: the bridge
 * launches it with the approval URL, and it POSTs a canned result to `/api/complete/:id`. This
 * exercises the whole stack — subprocess spawn, port discovery, `POST /api/v1/request`, the
 * browser-open path, and result unwrapping — without a real wallet.
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createWalletClient, http } from "viem";

import { WalletSignerClient } from "../src/client.ts";
import { connectWalletViem } from "../src/viem-account.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_WALLET = resolve(TEST_DIR, "fake-wallet.mjs");
const FAKE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Drive the bridge to launch our fake wallet instead of a real browser. The bridge runs the
// browser as `<browser> <url>` with no shell, so it must be a single executable — hence the
// fake wallet has a shebang and is chmod +x, and we pass its path directly.
const browser = FAKE_WALLET;

describe("WalletSignerClient", () => {
  let client: WalletSignerClient;

  before(async () => {
    client = new WalletSignerClient("evm", { browser, defaultChainId: 1 });
    await client.start();
  });

  after(async () => {
    await client.shutdown();
  });

  test("connectWallet returns the connected address", async () => {
    const address = await client.connectWallet({ chainId: 1 });
    assert.equal(address.toLowerCase(), FAKE_ADDRESS.toLowerCase());
  });

  test("sendTransaction returns a tx hash", async () => {
    const hash = await client.sendTransaction({
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: "1000000000000000000",
      chainId: 1,
    });
    assert.match(hash, /^0x[a-f0-9]+$/i);
  });

  test("signMessage returns a signature", async () => {
    const sig = await client.signMessage({ message: "Hello, Ethereum!", chainId: 1 });
    assert.match(sig, /^0x[a-f0-9]+$/i);
  });

  test("signTypedData returns a signature", async () => {
    const sig = await client.signTypedData({
      domain: { name: "Test App", version: "1", chainId: 1 },
      types: { Message: [{ name: "content", type: "string" }] },
      primaryType: "Message",
      message: { content: "Hello" },
      chainId: 1,
    });
    assert.match(sig, /^0x[a-f0-9]+$/i);
  });
});

describe("viem integration", () => {
  let client: WalletSignerClient;

  before(async () => {
    client = new WalletSignerClient("evm", { browser, defaultChainId: 1 });
    await client.start();
  });

  after(async () => {
    await client.shutdown();
  });

  test("connectWalletViem builds a hybrid account that signs messages directly", async () => {
    const { account } = await connectWalletViem(client, { chainId: 1 });
    assert.equal(account.address.toLowerCase(), FAKE_ADDRESS.toLowerCase());
    assert.equal(account.type, "json-rpc");

    // The hybrid account signs directly (the wallet path), independent of any wallet client.
    const sig = await account.signMessage({ message: "via viem" });
    assert.match(sig, /^0x[a-f0-9]+$/i);
  });

  test("wallet client routes sendTransaction through the transport", async () => {
    const { account, transport } = await connectWalletViem(client, {
      address: FAKE_ADDRESS,
      chainId: 1,
    });
    // For sends, viem treats a bare address as a JSON-RPC account and routes
    // eth_sendTransaction through our transport (→ the bridge → the wallet).
    const walletClient = createWalletClient({ account: account.address, transport });
    const hash = await walletClient.sendTransaction({
      account: account.address,
      chain: null,
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: 1000000000000000000n,
    });
    assert.match(hash, /^0x[a-f0-9]+$/i);
  });
});
