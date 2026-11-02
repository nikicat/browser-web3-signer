/**
 * A throwaway regtest chain for the real-Leather e2e: spawns `bitcoind -regtest` in a temp
 * datadir, and serves the Esplora HTTP API Leather reads a custom network through (UTXOs, address
 * txs, tx lookup, broadcast, fee estimates) straight from bitcoind's RPC — no electrs. The chain
 * stays tiny (a few hundred blocks), so every address query just rescans it.
 *
 * Unimplemented Esplora paths answer 404 and are logged to stderr, so a Leather upgrade that
 * starts reading something new shows up as a named path, not a mystery hang.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RPC_USER = "e2e";
const RPC_PASS = "e2e";

type Json = any;

export interface Regtest {
  /** Esplora API base URL (no trailing slash) — what Leather's custom network points at. */
  esploraUrl: string;
  rpc(method: string, ...params: unknown[]): Promise<Json>;
  /** Mine `n` blocks to the node's own wallet. */
  mine(n?: number): Promise<void>;
  /** Pay `sats` from the node's wallet to `address` and confirm it. Returns the txid. */
  fund(address: string, sats: number): Promise<string>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

export async function startRegtest(): Promise<Regtest> {
  const datadir = mkdtempSync(join(tmpdir(), "bw3s-regtest-"));
  const rpcPort = await freePort();
  const node: ChildProcess = spawn(
    "bitcoind",
    [
      "-regtest",
      `-datadir=${datadir}`,
      `-rpcport=${rpcPort}`,
      `-rpcuser=${RPC_USER}`,
      `-rpcpassword=${RPC_PASS}`,
      "-listen=0",
      "-txindex",
      "-fallbackfee=0.0001",
      "-printtoconsole=0",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  async function rpc(method: string, ...params: unknown[]): Promise<Json> {
    const res = await fetch(`http://127.0.0.1:${rpcPort}/`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64") },
      body: JSON.stringify({ jsonrpc: "1.0", id: method, method, params }),
    });
    const body = await res.json().catch(() => null);
    if (!body) throw new Error(`bitcoind ${method}: HTTP ${res.status}`);
    if (body.error) throw Object.assign(new Error(`bitcoind ${method}: ${body.error.message}`), { rpcCode: body.error.code });
    return body.result;
  }

  // Wait for RPC (warmup answers -28 until the node is ready).
  for (let i = 0; ; i++) {
    try {
      await rpc("getblockchaininfo");
      break;
    } catch (err) {
      if (i > 100) throw new Error(`bitcoind did not start: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await rpc("createwallet", "miner");
  const minerAddress: string = await rpc("getnewaddress");
  const mine = async (n = 1) => {
    await rpc("generatetoaddress", n, minerAddress);
  };
  await mine(101); // coinbase maturity

  const esplora = await serveEsplora(rpc);
  const { port } = esplora.address() as AddressInfo;

  return {
    esploraUrl: `http://127.0.0.1:${port}`,
    rpc,
    mine,
    async fund(address, sats) {
      const txid: string = await rpc("sendtoaddress", address, sats / 1e8);
      await mine(1);
      return txid;
    },
    async stop() {
      await new Promise((r) => esplora.close(r));
      await rpc("stop").catch(() => {});
      await new Promise((r) => (node.exitCode !== null ? r(null) : node.once("exit", r)));
      rmSync(datadir, { recursive: true, force: true });
    },
  };
}

// --- Esplora over bitcoind RPC ---

interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  vin: Json[];
  vout: { scriptpubkey: string; scriptpubkey_address?: string; scriptpubkey_type: string; value: number }[];
  size: number;
  weight: number;
  fee: number;
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
}

const sats = (btc: number) => Math.round(btc * 1e8);

/** bitcoind's verbose tx (verbosity 2/3, with prevouts) in Esplora's shape. */
function toEsplora(tx: Json, block?: { height: number; hash: string; time: number }): EsploraTx {
  const vout = tx.vout.map((o: Json) => ({
    scriptpubkey: o.scriptPubKey.hex,
    scriptpubkey_address: o.scriptPubKey.address,
    scriptpubkey_type: o.scriptPubKey.type,
    value: sats(o.value),
  }));
  const vin = tx.vin.map((i: Json) =>
    i.coinbase
      ? { is_coinbase: true, prevout: null, scriptsig: i.coinbase, sequence: i.sequence, witness: i.txinwitness ?? [] }
      : {
          txid: i.txid,
          vout: i.vout,
          is_coinbase: false,
          scriptsig: i.scriptSig?.hex ?? "",
          witness: i.txinwitness ?? [],
          sequence: i.sequence,
          prevout: i.prevout && {
            scriptpubkey: i.prevout.scriptPubKey.hex,
            scriptpubkey_address: i.prevout.scriptPubKey.address,
            scriptpubkey_type: i.prevout.scriptPubKey.type,
            value: sats(i.prevout.value),
          },
        },
  );
  const fee = vin.some((i: Json) => i.is_coinbase)
    ? 0
    : vin.reduce((s: number, i: Json) => s + (i.prevout?.value ?? 0), 0) - vout.reduce((s: number, o: Json) => s + o.value, 0);
  return {
    txid: tx.txid,
    version: tx.version,
    locktime: tx.locktime,
    vin,
    vout,
    size: tx.size,
    weight: tx.weight,
    fee,
    status: block
      ? { confirmed: true, block_height: block.height, block_hash: block.hash, block_time: block.time }
      : { confirmed: false },
  };
}

/** Every tx on the chain and in the mempool, newest first. ponytail: full rescan per query; fine
 * for a regtest chain of a few hundred blocks, an index if a test ever mines thousands. */
async function allTxs(rpc: Regtest["rpc"]): Promise<EsploraTx[]> {
  const out: EsploraTx[] = [];
  for (const txid of (await rpc("getrawmempool")) as string[]) {
    out.push(toEsplora(await rpc("getrawtransaction", txid, 2)));
  }
  const height: number = await rpc("getblockcount");
  for (let h = height; h >= 0; h--) {
    const block = await rpc("getblock", await rpc("getblockhash", h), 3);
    for (const tx of [...block.tx].reverse()) out.push(toEsplora(tx, { height: h, hash: block.hash, time: block.time }));
  }
  return out;
}

const touches = (tx: EsploraTx, addr: string) =>
  tx.vout.some((o) => o.scriptpubkey_address === addr) || tx.vin.some((i) => i.prevout?.scriptpubkey_address === addr);

async function addressView(rpc: Regtest["rpc"], addr: string) {
  const txs = (await allTxs(rpc)).filter((t) => touches(t, addr));
  const spent = new Set(txs.flatMap((t) => t.vin.filter((i) => i.prevout).map((i) => `${i.txid}:${i.vout}`)));
  const utxos = txs.flatMap((t) =>
    t.vout.flatMap((o, vout) =>
      o.scriptpubkey_address === addr && !spent.has(`${t.txid}:${vout}`)
        ? [{ txid: t.txid, vout, value: o.value, status: t.status }]
        : [],
    ),
  );
  const stats = (confirmed: boolean) => {
    const set = txs.filter((t) => t.status.confirmed === confirmed);
    const funded = set.flatMap((t) => t.vout.filter((o) => o.scriptpubkey_address === addr));
    const spends = set.flatMap((t) => t.vin.filter((i) => i.prevout?.scriptpubkey_address === addr));
    return {
      tx_count: set.length,
      funded_txo_count: funded.length,
      funded_txo_sum: funded.reduce((s, o) => s + o.value, 0),
      spent_txo_count: spends.length,
      spent_txo_sum: spends.reduce((s, i) => s + i.prevout.value, 0),
    };
  };
  return { txs, utxos, summary: { address: addr, chain_stats: stats(true), mempool_stats: stats(false) } };
}

async function serveEsplora(rpc: Regtest["rpc"]): Promise<Server> {
  const routes: [RegExp, (m: RegExpMatchArray, body: string) => Promise<unknown>][] = [
    [/^\/address\/([^/]+)$/, async (m) => (await addressView(rpc, m[1])).summary],
    [/^\/address\/([^/]+)\/utxo$/, async (m) => (await addressView(rpc, m[1])).utxos],
    [/^\/address\/([^/]+)\/txs(?:\/chain)?$/, async (m) => (await addressView(rpc, m[1])).txs.slice(0, 50)],
    [/^\/address\/([^/]+)\/txs\/mempool$/, async (m) => (await addressView(rpc, m[1])).txs.filter((t) => !t.status.confirmed)],
    [/^\/address\/([^/]+)\/txs\/chain\/([0-9a-f]{64})$/, async (m) => {
      const txs = (await addressView(rpc, m[1])).txs.filter((t) => t.status.confirmed);
      return txs.slice(txs.findIndex((t) => t.txid === m[2]) + 1).slice(0, 25);
    }],
    [/^\/tx\/([0-9a-f]{64})$/, async (m) => {
      const tx = await rpc("getrawtransaction", m[1], 2);
      const block = tx.blockhash && (await rpc("getblockheader", tx.blockhash));
      return toEsplora(tx, block ? { height: block.height, hash: block.hash, time: block.time } : undefined);
    }],
    [/^\/tx\/([0-9a-f]{64})\/hex$/, async (m) => rpc("getrawtransaction", m[1])],
    [/^\/tx\/([0-9a-f]{64})\/status$/, async (m) => {
      const tx = await rpc("getrawtransaction", m[1], 1);
      const block = tx.blockhash && (await rpc("getblockheader", tx.blockhash));
      return block ? { confirmed: true, block_height: block.height, block_hash: block.hash, block_time: block.time } : { confirmed: false };
    }],
    [/^\/tx$/, async (_m, body) => rpc("sendrawtransaction", body.trim())],
    [/^\/blocks\/tip\/height$/, async () => rpc("getblockcount")],
    [/^\/blocks\/tip\/hash$/, async () => rpc("getbestblockhash")],
    // Regtest has no fee market; quote the relay minimum for every target.
    [/^\/fee-estimates$/, async () => Object.fromEntries([1, 2, 3, 6, 12, 144].map((n) => [String(n), 1]))],
    [/^\/v1\/fees\/recommended$/, async () => ({ fastestFee: 2, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 })],
  ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      const text = typeof body === "string" || typeof body === "number" ? String(body) : JSON.stringify(body);
      res.writeHead(status, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Content-Type": typeof body === "object" ? "application/json" : "text/plain",
      });
      res.end(text);
    };
    if (req.method === "OPTIONS") return send(204, "");
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "") || "/";
    for (const [re, handler] of routes) {
      const m = path.match(re);
      if (!m) continue;
      try {
        return send(200, await handler(m, body));
      } catch (err) {
        const missing = (err as { rpcCode?: number }).rpcCode === -5;
        return send(missing ? 404 : 400, (err as Error).message);
      }
    }
    console.error(`[esplora] unimplemented: ${req.method} ${req.url}`);
    send(404, "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}
