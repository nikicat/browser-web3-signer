#!/usr/bin/env node
// Local-node helper for the TRON manual-test assistant (scripts/manual-test-tron.sh).
//
// TRON has no `cast`/`anvil`-style CLI, so this is the funding + verification layer the shell
// script drives: it talks to a local `tronbox/tre` node over TronWeb to fund the connected
// wallet, deploy/mint a demo TRC-20, read balances, and verify signatures + tx receipts.
//
// Everything here uses the node's pre-funded genesis key (GENESIS_KEY) — throwaway local TRX,
// never a real network. The wallet operations under test (connect/sign/send) are the browser
// signer's job; this tool only sets the stage and checks the results.
//
// Run directly with Node's native TypeScript support (node >= 22.6): `node tron-tool.ts`.
//
// Usage:  node tron-tool.ts <command> [args]
//   env:  NODE_HOST   local node HTTP endpoint (default http://127.0.0.1:9090)
//         GENESIS_KEY hex private key of a funded account (required for fund/deploy/mint)
//
// Commands:
//   accounts                                 print {privateKeys, addresses} JSON from the node
//   balance <addr>                           print TRX balance in SUN (integer)
//   fund <addr> <sun>                        transfer SUN from GENESIS_KEY to <addr>; print txid
//   deploy --abi <file> --bytecode <hex> [--name N]   deploy a contract; print its base58 address
//   mint <token> <to> <amount>               call mint(to,amount) from GENESIS_KEY; print txid
//   token-balance <token> <addr>             print balanceOf(addr) (raw integer)
//   tx-status <txid>                         poll for the receipt; print SUCCESS/FAILED (exit 1 on fail)
//   verify-message <addr> <message> <sig>    recover signMessageV2 signer; exit 0 iff it matches <addr>
//   verify-typed --file <f> --address <a> <sig>   recover TIP-712 signer; exit 0 iff it matches <a>

import { readFileSync } from "node:fs";
import { TronWeb } from "tronweb";
import { ethers } from "ethers";

const NODE_HOST: string = process.env.NODE_HOST || "http://127.0.0.1:9090";

// The demo token's minimal ABI. deploy() is handed the full forge-compiled ABI on the CLI; mint /
// token-balance only need these three entries, and they match scripts/manual-test-tron.sh's
// MintableERC20, so we embed them rather than thread the ABI file through every call.
const TOKEN_ABI = [
  { name: "mint", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amt", type: "uint256" }], outputs: [] },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amt", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
];

/** The subset of a getTransactionInfo response we care about. */
interface TxInfo {
  blockNumber?: number;
  result?: string;
  receipt?: { result?: string };
}

type Flags = Record<string, string>;

function die(msg: string): never {
  process.stderr.write(`tron-tool: ${msg}\n`);
  process.exit(1);
}

/** A TronWeb bound to the local node. Pass `signing: true` to require GENESIS_KEY for a write op. */
function makeTronWeb(signing: boolean): TronWeb {
  const privateKey = process.env.GENESIS_KEY;
  if (signing && !privateKey) die("GENESIS_KEY env var is required for this command");
  return new TronWeb(privateKey ? { fullHost: NODE_HOST, privateKey } : { fullHost: NODE_HOST });
}

/** Extract `--flag value` pairs, returning [flags, positionals]. */
function parseArgs(argv: string[]): [Flags, string[]] {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return [flags, positional];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll for a transaction's on-chain info until it lands in a block (or we give up). */
async function waitForReceipt(tw: TronWeb, txid: string, tries = 30): Promise<TxInfo | null> {
  for (let i = 0; i < tries; i++) {
    await sleep(1500);
    const info = (await tw.trx.getTransactionInfo(txid).catch(() => null)) as TxInfo | null;
    if (info && info.blockNumber) return info;
  }
  return null;
}

/** True when a receipt represents success (TRX transfers have no receipt.result; contracts do). */
function receiptOk(info: TxInfo | null): boolean {
  if (!info) return false;
  if (info.result === "FAILED") return false;
  const r = info.receipt && info.receipt.result;
  return !r || r === "SUCCESS";
}

const COMMANDS: Record<string, (pos: string[], flags: Flags) => Promise<void>> = {
  async accounts() {
    const res = await fetch(`${NODE_HOST}/admin/accounts-json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) die(`accounts-json HTTP ${res.status} — is the node up?`);
    const data = (await res.json()) as { privateKeys?: string[] };
    const privateKeys = data.privateKeys || [];
    if (privateKeys.length === 0) die("node returned no pre-funded accounts");
    const addresses = privateKeys.map((k) => TronWeb.address.fromPrivateKey(k));
    process.stdout.write(JSON.stringify({ privateKeys, addresses }) + "\n");
  },

  async balance([addr]) {
    if (!addr) die("usage: balance <addr>");
    const tw = makeTronWeb(false);
    const bal = await tw.trx.getBalance(addr);
    process.stdout.write(BigInt(bal.toString()).toString() + "\n");
  },

  async fund([addr, sun]) {
    if (!addr || !sun) die("usage: fund <addr> <sun>");
    const tw = makeTronWeb(true);
    const tx = await tw.trx.sendTransaction(addr, Number(BigInt(sun)));
    const txid = tx.txid || (tx.transaction && tx.transaction.txID);
    if (!tx.result || !txid) die(`fund failed: ${JSON.stringify(tx)}`);
    if (!receiptOk(await waitForReceipt(tw, txid))) die(`fund tx ${txid} did not confirm successfully`);
    process.stdout.write(txid + "\n");
  },

  async deploy(_pos, flags) {
    if (!flags.abi || !flags.bytecode) die("usage: deploy --abi <file> --bytecode <hex> [--name N]");
    const tw = makeTronWeb(true);
    const abi = JSON.parse(readFileSync(flags.abi, "utf-8"));
    const bytecode = flags.bytecode.replace(/^0x/, "");
    const inst = await tw.contract().new({
      abi, bytecode, feeLimit: 1_000_000_000, callValue: 0,
      name: flags.name || "MintableERC20", parameters: [],
    });
    // A freshly deployed instance carries the contract address as hex (41-prefixed).
    process.stdout.write(TronWeb.address.fromHex(inst.address) + "\n");
  },

  async mint([token, to, amount]) {
    if (!token || !to || !amount) die("usage: mint <token> <to> <amount>");
    const tw = makeTronWeb(true);
    const contract = tw.contract(TOKEN_ABI, token);
    const txid: string = await contract.mint(to, amount).send({ feeLimit: 1_000_000_000 });
    if (!receiptOk(await waitForReceipt(tw, txid))) die(`mint tx ${txid} did not confirm successfully`);
    process.stdout.write(txid + "\n");
  },

  async "token-balance"([token, addr]) {
    if (!token || !addr) die("usage: token-balance <token> <addr>");
    const tw = makeTronWeb(false);
    const contract = tw.contract(TOKEN_ABI, token);
    const bal = await contract.balanceOf(addr).call();
    process.stdout.write(BigInt(bal.toString()).toString() + "\n");
  },

  async "tx-status"([txid]) {
    if (!txid) die("usage: tx-status <txid>");
    const tw = makeTronWeb(false);
    const info = await waitForReceipt(tw, txid);
    if (!info) {
      process.stdout.write("PENDING\n");
      process.exit(1);
    }
    const ok = receiptOk(info);
    const detail = (info.receipt && info.receipt.result) || (info.result === "FAILED" ? "FAILED" : "SUCCESS");
    process.stdout.write(`${ok ? "SUCCESS" : "FAILED"} (${detail})\n`);
    process.exit(ok ? 0 : 1);
  },

  async "verify-message"([addr, message, sig]) {
    if (!addr || message === undefined || !sig) die("usage: verify-message <addr> <message> <sig>");
    const tw = makeTronWeb(false);
    const recovered = await tw.trx.verifyMessageV2(message, sig);
    const match = recovered === addr;
    process.stdout.write(`${match ? "MATCH" : "NOMATCH"} ${recovered}\n`);
    process.exit(match ? 0 : 1);
  },

  // TIP-712 mirrors EIP-712, so ethers recovers the underlying secp256k1 signer (an 0x address);
  // prefixing 0x41 and base58-checking it yields the TRON address to compare against.
  async "verify-typed"(pos, flags) {
    const sig = pos[0];
    if (!flags.file || !flags.address || !sig) die("usage: verify-typed --file <f> --address <a> <sig>");
    const parsed = JSON.parse(readFileSync(flags.file, "utf-8"));
    const types = { ...parsed.types };
    delete types.EIP712Domain; // ethers derives the domain type itself
    const recoveredEth = ethers.verifyTypedData(parsed.domain, types, parsed.message, sig);
    const recovered = TronWeb.address.fromHex("41" + recoveredEth.slice(2));
    const match = recovered === flags.address;
    process.stdout.write(`${match ? "MATCH" : "NOMATCH"} ${recovered}\n`);
    process.exit(match ? 0 : 1);
  },
};

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) die(`unknown command: ${command || "(none)"}`);
  const [flags, positional] = parseArgs(rest);
  await handler(positional, flags);
}

main().catch((err: unknown) => die(err instanceof Error ? err.message : String(err)));
