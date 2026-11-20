/**
 * Unit tests for the viem transport's routing, against a stub signer instead of the Rust bridge.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createWalletClient } from "viem";

import {
  NoReadRpcError,
  walletSignerTransport,
  type WalletSignerTransportOptions,
} from "../src/transport.ts";

import { ADDRESS, MAIL, recordingSigner } from "./fixtures.ts";

const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BLOCK_NUMBER = "0x10";

/** A transport over a recording signer, with the arrays that signer records into. */
function harness(options?: WalletSignerTransportOptions) {
  const { signer, sent, signed } = recordingSigner();
  const transport = walletSignerTransport(signer, options);
  return { transport, request: transport({}).request, sent, signed };
}

function signTypedDataRequest(typedData: object) {
  return {
    method: "eth_signTypedData_v4",
    params: [ADDRESS, JSON.stringify(typedData)],
  } as const;
}

/** Serves `reply` (merged with the request's id) to every JSON-RPC POST until `close` is called. */
async function jsonRpcServer(reply: object) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    rpcUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("walletSignerTransport", () => {
  test("sends a transaction on the configured chain", async () => {
    const { transport, sent } = harness({ chainId: 43114 });
    const wallet = createWalletClient({ account: ADDRESS, transport });
    await wallet.sendTransaction({ account: ADDRESS, chain: null, to: TO, value: 1n });
    assert.deepEqual(sent, [{ to: TO, from: ADDRESS, value: "1", chainId: 43114 }]);
  });

  test("keeps a chain id the request carries", async () => {
    const { request, sent } = harness({ chainId: 43114 });
    const tx = { from: ADDRESS, to: TO, chainId: "0x1" } as const;
    await request({ method: "eth_sendTransaction", params: [tx] });
    assert.equal(sent[0]?.chainId, 1);
  });

  test("signs a message and typed data on the configured chain", async () => {
    const { request, signed } = harness({ chainId: 43114 });
    await request({ method: "personal_sign", params: ["0x6869", ADDRESS] });
    await request(signTypedDataRequest(MAIL));
    assert.deepEqual(signed.map((params) => params.chainId), [43114, 43114]);
  });

  test("passes valid typed data to the signer unchanged", async () => {
    const { request, signed } = harness();
    await request(signTypedDataRequest(MAIL));
    assert.deepEqual(signed, [{ ...MAIL, address: ADDRESS }]);
  });

  test("rejects typed data whose message does not fit its types", async () => {
    const { request, signed } = harness();
    await assert.rejects(
      request(signTypedDataRequest({ ...MAIL, message: { to: "not an address" } })),
      { name: "InvalidAddressError" },
    );
    assert.deepEqual(signed, []);
  });

  test("sends no chain id when none is configured", async () => {
    const { request, sent } = harness();
    await request({ method: "eth_sendTransaction", params: [{ from: ADDRESS, to: TO }] });
    assert.deepEqual(sent, [{ from: ADDRESS, to: TO }]);
  });

  test("sends the chain-reading calls to the provider", async () => {
    const reads: unknown[] = [];
    const provider = {
      request: (args: unknown) => (reads.push(args), Promise.resolve(BLOCK_NUMBER)),
    };
    const { request } = harness({ chainId: 1, provider });
    assert.equal(await request({ method: "eth_blockNumber" }), BLOCK_NUMBER);
    assert.equal(await request({ method: "eth_chainId" }), "0x1");
    assert.deepEqual(reads, [{ method: "eth_blockNumber", params: undefined }]);
  });

  test("sends the chain-reading calls to the rpcUrl", async () => {
    const node = await jsonRpcServer({ result: BLOCK_NUMBER });
    try {
      const { request } = harness({ rpcUrl: node.rpcUrl });
      assert.equal(await request({ method: "eth_blockNumber" }), BLOCK_NUMBER);
    } finally {
      await node.close();
    }
  });

  test("rejects with the rpcUrl's JSON-RPC error message", async () => {
    const node = await jsonRpcServer({ error: { code: -32000, message: "header not found" } });
    try {
      const { request } = harness({ rpcUrl: node.rpcUrl });
      await assert.rejects(request({ method: "eth_blockNumber" }), /header not found/);
    } finally {
      await node.close();
    }
  });

  test("refuses a chain-reading call with neither rpcUrl nor provider", async () => {
    const { request } = harness({ chainId: 1 });
    await assert.rejects(request({ method: "eth_blockNumber" }), NoReadRpcError);
  });

  test("rejects both rpcUrl and provider at compile time", () => {
    const provider = { request: () => Promise.resolve(BLOCK_NUMBER) };
    // @ts-expect-error a transport reads through one source
    walletSignerTransport(recordingSigner().signer, { rpcUrl: "http://localhost:8545", provider });
  });
});
