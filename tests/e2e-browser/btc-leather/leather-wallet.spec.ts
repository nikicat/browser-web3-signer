/**
 * Real-wallet e2e for Bitcoin: the actual `browser-web3-signer btc …` CLI, the real Leather
 * extension, a throwaway regtest chain. Each step runs a CLI command, opens its approval URL in
 * the Leather browser, approves Leather's popup, and verifies the CLI's output against the node
 * (`testmempoolaccept`, mempool lookups) and bip322-js.
 *
 * Needs `bitcoind` on PATH and a Leather `build:test` dist in LEATHER_EXT_DIR (see README);
 * skips when the extension isn't there, so the mock-wallet suite runs without it.
 */

import * as ecc from "@bitcoinerlab/secp256k1";
import { expect, type Page, test } from "@playwright/test";
import { Verifier } from "bip322-js";
import * as bitcoin from "bitcoinjs-lib";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approve,
  approveAccounts,
  approveMessage,
  approvePsbt,
  approveTransfer,
  cancel,
  closePopups,
  launchLeather,
  type Leather,
  type PopupAction,
  leatherExtDir,
} from "./fixtures/leather.mts";
import { type Regtest, startRegtest } from "./fixtures/regtest.mts";

bitcoin.initEccLib(ecc);
const REGTEST = bitcoin.networks.regtest;
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// One port for the whole run, so Leather sees one origin and remembers the connection.
const BRIDGE_PORT = "38490";

const extDir = leatherExtDir();
test.skip(!extDir, "LEATHER_EXT_DIR is not set (build Leather with `just e2e-leather-build`)");
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

let chain: Regtest;
let leather: Leather;
let page: Page;
let address = ""; // the wallet's payment address, from connect

test.beforeAll(async () => {
  chain = await startRegtest();
  leather = await launchLeather(extDir!, chain.esploraUrl);
  page = await leather.context.newPage();
});

test.afterAll(async () => {
  await leather?.close();
  await chain?.stop();
});

/** The most recently built signer binary (a stale release build must not shadow a fresh debug one). */
function signerBin(): string {
  const [found] = ["release", "debug"]
    .map((p) => resolve(WORKSPACE, `target/${p}/browser-web3-signer`))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!found) throw new Error("browser-web3-signer not built: run `cargo build`");
  return found;
}

/** Run a `btc` CLI command; resolves its approval URL, then its parsed JSON output. */
function cli(...args: string[]): { url: Promise<string>; output: Promise<any> } {
  const proc = spawn(signerBin(), ["--print", "--json", "btc", ...args, "--network", "regtest"], {
    env: { ...process.env, BROWSER_WEB3_BTC_PORT: BRIDGE_PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d));
  const url = new Promise<string>((res, rej) => {
    proc.stderr.on("data", (d) => {
      stderr += d;
      const m = stderr.match(/Approval URL: (\S+)/);
      if (m) res(m[1]);
    });
    proc.on("exit", () => rej(new Error(`CLI exited before printing a URL: ${stderr}`)));
  });
  const output = new Promise((res, rej) =>
    proc.on("exit", (code) =>
      code === 0 ? res(JSON.parse(stdout)) : rej(new Error(`CLI exited ${code}: ${stderr.trim()}`)),
    ),
  );
  return { url, output };
}

/** Open a CLI command's approval page, click its button, and approve Leather's popup. */
async function run(args: string[], button: string, action: PopupAction) {
  await closePopups(leather);
  const { url, output } = cli(...args);
  await page.goto(await url);
  await page.getByRole("button", { name: button, exact: true }).click();
  await approve(leather, action);
  return output;
}

/** A 1-in/1-out PSBT spending the wallet's largest UTXO back to it, at 2 sat/vB. */
async function buildPsbt(): Promise<string> {
  const utxos: { txid: string; vout: number; value: number }[] = await (
    await fetch(`${chain.esploraUrl}/address/${address}/utxo`)
  ).json();
  const utxo = utxos.reduce((a, b) => (b.value > a.value ? b : a));
  const script = bitcoin.address.toOutputScript(address, REGTEST);
  const psbt = new bitcoin.Psbt({ network: REGTEST });
  psbt.addInput({ hash: utxo.txid, index: utxo.vout, witnessUtxo: { script, value: BigInt(utxo.value) } });
  psbt.addOutput({ script, value: BigInt(utxo.value - 300) });
  return psbt.toHex();
}

let psbtHex = "";
let psbtTxid = "";

test("connect returns the wallet's regtest address", async () => {
  const out = await run(["connect"], "Connect", approveAccounts);
  address = out.address;
  expect(address).toMatch(/^bcrt1q/);
  await chain.fund(address, 1_000_000);
});

test("sign-message (BIP-322) verifies for the wallet's address", async () => {
  const message = `e2e ${Date.now()}`;
  const out = await run(["sign-message", "--message", message, "--address", address], "Sign", approveMessage);
  expect(Verifier.verifySignature(address, message, out.signature)).toBe(true);
});

test("send pays the recipient on-chain", async () => {
  const recipient: string = await chain.rpc("getnewaddress", "", "bech32");
  const out = await run(["send", "--to", recipient, "--amount", "50000", "--from", address], "Sign & Send", approveTransfer);
  const tx = await chain.rpc("getrawtransaction", out.txid, 1);
  expect(tx.vout.some((o: any) => o.scriptPubKey.address === recipient && Math.round(o.value * 1e8) === 50000)).toBe(true);
  await chain.mine(1);
});

test("sign-psbt (no broadcast) returns signatures the node accepts", async () => {
  psbtHex = await buildPsbt();
  const out = await run(["sign-psbt", "--psbt", psbtHex, "--sign-input", "0", "--from", address], "Sign", approvePsbt);
  expect(out.txid).toBeNull();
  const signed = bitcoin.Psbt.fromHex(out.psbt, { network: REGTEST });
  signed.finalizeAllInputs();
  const tx = signed.extractTransaction();
  psbtTxid = tx.getId();
  const [accept] = await chain.rpc("testmempoolaccept", [tx.toHex()]);
  expect(accept).toMatchObject({ txid: psbtTxid, allowed: true });
});

test("sign-psbt --broadcast puts the same transaction in the mempool", async () => {
  const out = await run(["sign-psbt", "--psbt", psbtHex, "--broadcast", "--from", address], "Sign & Broadcast", approvePsbt);
  expect(out.txid).toBe(psbtTxid);
  expect(await chain.rpc("getmempoolentry", psbtTxid)).toBeTruthy();
  await chain.mine(1);
});

test("a rejection in Leather stays in-page; Reject reaches the CLI", async () => {
  await closePopups(leather);
  const { url, output } = cli("sign-message", "--message", "no", "--address", address);
  await page.goto(await url);
  await page.getByRole("button", { name: "Sign", exact: true }).click();
  await approve(leather, cancel);
  await expect(page.locator("#msg-err")).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(output).rejects.toThrow(/rejected/i);
});
