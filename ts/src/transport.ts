/**
 * A viem `CustomTransport` that routes wallet methods through the {@link WalletSignerClient}
 * (i.e. the browser wallet, via the Rust bridge) and forwards all other JSON-RPC methods to a
 * plain read RPC. Ported from the reference `transport.ts`, retargeted at the HTTP client.
 */

import { custom, hexToBytes } from "viem";
import type { CustomTransport, Hex } from "viem";

import type { SendTransactionParams, SignableMessage, WalletSignerClient } from "./client.ts";

/** Options for {@link walletSignerTransport}. */
export interface WalletSignerTransportOptions {
  /** JSON-RPC endpoint for chain-reading calls (everything not routed to the wallet). */
  rpcUrl?: string;
  /** Default chain id, surfaced for `eth_chainId`. */
  chainId?: number;
}

/** Create a viem custom transport backed by a {@link WalletSignerClient}. */
export function walletSignerTransport(
  signer: WalletSignerClient,
  options?: WalletSignerTransportOptions,
): CustomTransport {
  return custom(
    {
      async request({ method, params }) {
        switch (method) {
          case "personal_sign": {
            const [messageHex, address] = params as [Hex, string];
            return signer.signMessage({ message: signableFromHex(messageHex), address });
          }

          case "eth_sendTransaction": {
            const [tx] = params as [Partial<Record<string, string>>];
            if (!tx.to) throw new Error("eth_sendTransaction requires a `to` address");
            const sendParams: SendTransactionParams = { to: tx.to };
            if (tx.from) sendParams.from = tx.from;
            if (tx.data) sendParams.data = tx.data;
            if (tx.value) sendParams.value = BigInt(tx.value).toString();
            if (tx.gas) sendParams.gasLimit = BigInt(tx.gas).toString();
            if (tx.maxFeePerGas) sendParams.maxFeePerGas = BigInt(tx.maxFeePerGas).toString();
            if (tx.maxPriorityFeePerGas) {
              sendParams.maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas).toString();
            }
            if (tx.chainId) sendParams.chainId = Number(BigInt(tx.chainId));
            return signer.sendTransaction(sendParams);
          }

          case "eth_signTypedData_v4": {
            const [address, typedDataJson] = params as [string, string];
            const { domain, types, primaryType, message } = JSON.parse(typedDataJson);
            return signer.signTypedData({ domain, types, primaryType, message, address });
          }

          case "eth_chainId": {
            if (options?.chainId === undefined) {
              throw new Error("eth_chainId requested but no chainId configured on the transport");
            }
            return `0x${options.chainId.toString(16)}`;
          }

          default: {
            if (!options?.rpcUrl) {
              throw new Error(
                `No rpcUrl configured for read method ${method}. Pass rpcUrl in transport options.`,
              );
            }
            const resp = await fetch(options.rpcUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
            });
            const json = (await resp.json()) as {
              result?: unknown;
              error?: { message?: string };
            };
            if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
            return json.result;
          }
        }
      },
    },
    { retryCount: 0 },
  );
}

/**
 * Returns `personal_sign` bytes as text when they are exactly the UTF-8 of some text, so the
 * approval page shows it readably, and as `{ raw }` otherwise (e.g. a hash).
 */
function signableFromHex(hex: Hex): SignableMessage {
  try {
    // fatal: invalid UTF-8 throws; ignoreBOM keeps a leading BOM, so text re-encodes to `hex`.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(hexToBytes(hex));
  } catch {
    return { raw: hex };
  }
}
