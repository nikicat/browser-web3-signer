#!/usr/bin/env node
/**
 * A fake "browser" for tests. The Rust bridge launches the configured browser as
 * `<name> <approval-url>`; this script stands in for that browser + wallet:
 *   1. parse the approval URL (`http://127.0.0.1:<port>/{connect,sign}/<id>`),
 *   2. read the pending request via `GET /api/pending/:id` to learn its `type`,
 *   3. POST a canned success result to `/api/complete/:id`,
 * which unblocks the control-API request the client is awaiting.
 *
 * Canned results mirror what a real wallet would return per request type.
 */

const FAKE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FAKE_TRON_ADDRESS = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
const FAKE_TX_HASH = "0x" + "ab".repeat(32);
const FAKE_SIGNATURE = "0x" + "cd".repeat(65);
// Answers a `{ raw }` sign_message, so tests can tell which message shape reached the bridge.
const FAKE_RAW_SIGNATURE = "0x" + "ee".repeat(65);
// Bitcoin: `serve` checks these against the request, so they must be well-formed regtest values.
const FAKE_BTC_ADDRESS = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
// The secp256k1 generator, compressed: any well-formed key will do.
const FAKE_BTC_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const FAKE_BTC_TXID = "ab".repeat(32);
const FAKE_BTC_SIGNATURE = Buffer.alloc(65, 0xcd).toString("base64");
// The txid of the PSBT the binding tests sign (rust-bitcoin's BIP-174 vector); a
// broadcast answers with it, as `serve` requires the txid to match the PSBT.
const BTC_TEST_PSBT_TXID = "75c5c9665a570569ad77dd1279e6fd4628a093c4dcbf8d41532614044c14c115";
// Networks only Bitcoin has (TRON's are mainnet/shasta/nile), so binding tests use these.
const BTC_ONLY_NETWORKS = new Set(["testnet", "testnet4", "signet", "regtest"]);

const url = process.argv[2];
if (!url) {
  console.error("fake-wallet: no URL argument");
  process.exit(1);
}

const parsed = new URL(url);
const id = parsed.pathname.split("/").pop();
const base = `${parsed.protocol}//${parsed.host}`;

function btcResultFor(request) {
  switch (request.type) {
    case "connect":
      return JSON.stringify({ address: FAKE_BTC_ADDRESS, publicKey: FAKE_BTC_PUBLIC_KEY });
    case "send_transfer":
      return FAKE_BTC_TXID;
    case "sign_psbt":
      // Hands the PSBT back unchanged: still the same transaction, which is what `serve` checks.
      return JSON.stringify({ psbt: request.psbt, txid: request.broadcast ? BTC_TEST_PSBT_TXID : undefined });
    default:
      return FAKE_BTC_SIGNATURE;
  }
}

function resultFor(request) {
  if (BTC_ONLY_NETWORKS.has(request?.network)) return btcResultFor(request);
  // TRON requests carry a `network` field (EVM ones a `chainId`); `trigger_contract` /
  // `deploy_contract` are TRON-only.
  const isTron = typeof request?.network === "string";
  switch (request?.type) {
    case "connect":
      return isTron ? FAKE_TRON_ADDRESS : FAKE_ADDRESS;
    case "send_transaction":
    case "trigger_contract":
      return FAKE_TX_HASH;
    case "deploy_contract":
      // Mirrors the real TRON UI's deploy result shape (see the Rust parse_deploy_result).
      return JSON.stringify({ txHash: FAKE_TX_HASH, contractAddress: FAKE_TRON_ADDRESS });
    case "sign_message":
      return typeof request.message === "string" ? FAKE_SIGNATURE : FAKE_RAW_SIGNATURE;
    case "sign_typed_data":
      return FAKE_SIGNATURE;
    default:
      return FAKE_SIGNATURE;
  }
}

try {
  const pendingRes = await fetch(`${base}/api/pending/${id}`);
  const { request } = await pendingRes.json();
  const result = resultFor(request);
  await fetch(`${base}/api/complete/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, result }),
  });
} catch (err) {
  console.error("fake-wallet: failed to complete request:", err);
  process.exit(1);
}
