#!/usr/bin/env node
// Debugging JSON-RPC logging proxy. Sits between a wallet and anvil so we can SEE exactly what
// the wallet calls on the RPC (fee history, gas price, block fetches, …) and what comes back.
//
// Usage:  node rpc-log-proxy.mjs <listen_port> <upstream_url>
//   e.g.  node rpc-log-proxy.mjs 8545 http://127.0.0.1:8546
//
// Every request logs: method, params (truncated), upstream HTTP status, and any JSON-RPC error.
// CORS is echoed permissively so the wallet extension is never blocked by the proxy itself.

import http from "node:http";

const LISTEN_PORT = Number.parseInt(process.argv[2] ?? "8545", 10);
const UPSTREAM = process.argv[3] ?? "http://127.0.0.1:8546";

function ts() {
  return new Date().toISOString().slice(11, 23);
}

const server = http.createServer((req, res) => {
  // Preflight — answer directly so we can observe it too.
  if (req.method === "OPTIONS") {
    console.log(`${ts()}  OPTIONS ${req.url}  (CORS preflight)`);
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const bodyRaw = Buffer.concat(chunks).toString("utf-8");
    let parsed;
    try {
      parsed = JSON.parse(bodyRaw);
    } catch {
      parsed = null;
    }
    // A batch is an array; log each method (with params for the revealing ones).
    const calls = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const INTERESTING = new Set([
      "eth_getBalance", "eth_sendTransaction", "eth_sendRawTransaction", "eth_estimateGas",
      "eth_getTransactionCount", "eth_chainId",
    ]);
    const methods = calls
      .filter((c) => c && c.method)
      .map((c) => (INTERESTING.has(c.method) ? `${c.method} ${JSON.stringify(c.params)}` : c.method));

    try {
      // Preserve the request path + method so multi-endpoint APIs route correctly (TRON uses
      // /wallet/* and /jsonrpc; EVM uses a single "/" path, so this stays correct there too).
      const upstreamRes = await fetch(UPSTREAM + (req.url || ""), {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyRaw,
      });
      const text = await upstreamRes.text();

      // Surface JSON-RPC-level errors, and the RESULT for balance/gas calls (so we can see
      // exactly what the wallet was told, not just which method it called).
      let rpcErr = "";
      let resultNote = "";
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : [j];
        const errs = arr.filter((e) => e && e.error).map((e) => JSON.stringify(e.error));
        if (errs.length) rpcErr = "  ⚠ rpc-error: " + errs.join(", ");
        // For single (non-batch) balance/fee reads, echo the returned value.
        if (!Array.isArray(j) && j && j.result !== undefined && calls[0] &&
            ["eth_getBalance", "eth_gasPrice", "eth_estimateGas", "eth_getTransactionCount", "eth_chainId"].includes(calls[0].method)) {
          resultNote = "  = " + JSON.stringify(j.result);
        }
      } catch { /* non-JSON response */ }

      for (const m of methods) {
        console.log(`${ts()}  ${req.method} ${req.url}  → ${m}  [HTTP ${upstreamRes.status}]${resultNote}${rpcErr}`);
      }
      if (methods.length === 0) {
        // Non-JSON-RPC bodies (e.g. TRON's /wallet/* endpoints) — still log path so we see every hit.
        console.log(`${ts()}  ${req.method} ${req.url}  [HTTP ${upstreamRes.status}] body: ${bodyRaw.slice(0, 80)}`);
      }

      res.writeHead(upstreamRes.status, {
        "Content-Type": "application/json",
        ...corsHeaders(req),
      });
      res.end(text);
    } catch (err) {
      console.log(`${ts()}  ✗ upstream fetch failed for [${methods.join(", ")}]: ${err.message}`);
      res.writeHead(502, corsHeaders(req));
      res.end(JSON.stringify({ error: "proxy upstream failed: " + err.message }));
    }
  });
});

function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": req.headers.origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`${ts()}  rpc-log-proxy listening on 127.0.0.1:${LISTEN_PORT} → ${UPSTREAM}`);
});
