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
const FAKE_TX_HASH = "0x" + "ab".repeat(32);
const FAKE_SIGNATURE = "0x" + "cd".repeat(65);

const url = process.argv[2];
if (!url) {
  console.error("fake-wallet: no URL argument");
  process.exit(1);
}

const parsed = new URL(url);
const id = parsed.pathname.split("/").pop();
const base = `${parsed.protocol}//${parsed.host}`;

function resultFor(type) {
  switch (type) {
    case "connect":
      return FAKE_ADDRESS;
    case "send_transaction":
    case "trigger_contract":
      return FAKE_TX_HASH;
    case "sign_message":
    case "sign_typed_data":
      return FAKE_SIGNATURE;
    default:
      return FAKE_SIGNATURE;
  }
}

try {
  const pendingRes = await fetch(`${base}/api/pending/${id}`);
  const { request } = await pendingRes.json();
  const result = resultFor(request?.type);
  await fetch(`${base}/api/complete/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, result }),
  });
} catch (err) {
  console.error("fake-wallet: failed to complete request:", err);
  process.exit(1);
}
