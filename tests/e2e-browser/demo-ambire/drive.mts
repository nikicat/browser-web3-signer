/**
 * Verification driver: spawns anvil, boots Ambire from the baked fixture (no
 * onboarding), runs the real browser-web3-signer CLI, and approves the wallet
 * popups — sign-message, then send-transaction on the "Anvil (local)" network,
 * checking the receipt on-chain. Exit 0 = both flows verified.
 *
 * Run: ./setup.sh (once) && xvfb-run -a -s "-screen 0 1600x1000x24" node drive.mts
 * Env: SKIP_SIGN=1 skips the sign-message flow (faster tx-only iteration).
 */

import { join } from "node:path";
import { ANVIL_CHAIN_ID, CLI } from "./config.mts";
import { approveRequestWindow, bootAmbire, registerCleanup, runCli, sleep, startAnvil } from "./lib.mts";

if (!CLI) throw new Error("browser-web3-signer binary not found — cargo build first");
registerCleanup();

const rpc = await startAnvil(join(import.meta.dirname, "anvil.log"));
console.log("anvil up");

const { ctx } = await bootAmbire();
console.log("unlocked");

const dapp = await ctx.newPage();
dapp.setDefaultTimeout(60000);

// ---- flow 1: sign-message (connect authorization + signature) ----
if (!process.env.SKIP_SIGN) {
  console.log("--- flow 1: sign-message ---");
  const f1 = runCli(CLI, ["evm", "sign-message", "--message", "hello from the demo"]);
  await dapp.goto(await f1.url, { waitUntil: "load" });
  await dapp.getByRole("button", { name: /connect|sign/i }).first().click();
  if (!(await approveRequestWindow(ctx, ["dapp-connect-button"], { verbose: true }))) {
    throw new Error("connect window not approved");
  }
  if (!(await approveRequestWindow(ctx, ["button-sign"], { verbose: true }))) {
    throw new Error("sign window not approved");
  }
  await f1.exit;
  const sig = JSON.parse(f1.out() || "{}").signature;
  if (!sig) throw new Error(`flow 1 failed: ${f1.err().slice(-300)}`);
  console.log("signature:", sig.slice(0, 24), "…");
}

// ---- flow 2: send-transaction on anvil ----
console.log("--- flow 2: send-transaction (anvil) ---");
const f2 = runCli(CLI, [
  "evm",
  "send-transaction",
  "--to",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "--value",
  "1000000000000000000",
  "--chain",
  String(ANVIL_CHAIN_ID),
]);
await dapp.goto(await f2.url, { waitUntil: "load" });
await dapp.getByRole("button", { name: /sign|connect/i }).first().click();
// A connect window appears first if flow 1 was skipped on a fresh profile.
const first = await approveRequestWindow(ctx, ["dapp-connect-button", "transaction-button-sign"], { verbose: true });
if (first !== "transaction-button-sign") {
  await approveRequestWindow(ctx, ["transaction-button-sign"], { rounds: 6, verbose: true });
}
await f2.exit;
const txHash = JSON.parse(f2.out() || "{}").txHash;
if (!txHash) throw new Error(`flow 2 failed: cli stderr tail=${f2.err().slice(-300)}`);
console.log("tx hash:", txHash);

let receipt = null;
for (let i = 0; i < 30 && !receipt; i++) {
  receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt) await sleep(500);
}
console.log("receipt status:", receipt?.status, "block:", receipt?.blockNumber);
console.log(receipt?.status === "0x1" ? "PASS: both flows verified" : "FAIL: no successful receipt");
await ctx.close();
process.exit(receipt?.status === "0x1" ? 0 : 1);
