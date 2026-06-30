/**
 * Client for the Rust `serve` control API. The cross-language analog of the reference's
 * in-process `WalletSigner`: it spawns the Rust subprocess (which owns the bridge + persistent
 * browser tab) and drives it over `POST /api/v1/request`.
 *
 * Construct once and reuse for many operations — the subprocess holds a stable port for its
 * lifetime, so the wallet skips the reconnect prompt across calls.
 */

import { ServeProcess, type Chain, type ServeProcessOptions } from "./serve-process.ts";

/** Discriminating code the bridge attaches to a rejection. Mirrors the Rust `code` module. */
export const SignerErrorCode = {
  WrongWalletAddress: "WRONG_WALLET_ADDRESS",
} as const;

/** Thrown when the connected wallet account differs from the address the caller required. */
export class WrongWalletAddressError extends Error {
  override readonly name = "WrongWalletAddressError";
  constructor(message: string) {
    super(message);
  }
}

/** The control API's response envelope (`{success, result}` or `{success:false, error, code?}`). */
interface RequestResponse {
  success: boolean;
  result?: string;
  error?: string;
  code?: string;
}

/** Options for {@link WalletSignerClient}. */
export interface WalletSignerClientOptions extends ServeProcessOptions {
  /** Default chain id (EVM) / network — sent when a request omits one. */
  defaultChainId?: number;
}

/** Parameters for {@link WalletSignerClient.sendTransaction}. */
export interface SendTransactionParams {
  to: string;
  from?: string;
  value?: string;
  data?: string;
  chainId?: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

/** Parameters for {@link WalletSignerClient.signMessage}. */
export interface SignMessageParams {
  message: string;
  address?: string;
  chainId?: number;
}

/** Parameters for {@link WalletSignerClient.signTypedData}. */
export interface SignTypedDataParams {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
  address?: string;
  chainId?: number;
}

/**
 * A long-lived client over a managed Rust `serve` subprocess. Mirrors the reference
 * `WalletSigner` surface (connect / sendTransaction / signMessage / signTypedData) but talks to
 * the Rust bridge over HTTP instead of owning an in-process server.
 */
export class WalletSignerClient {
  readonly #serve: ServeProcess;
  readonly #defaultChainId?: number;

  constructor(chain: Chain = "evm", options?: WalletSignerClientOptions) {
    this.#serve = new ServeProcess(chain, options);
    this.#defaultChainId = options?.defaultChainId;
  }

  /** Start the subprocess (idempotent). Called automatically on first request. */
  async start(): Promise<void> {
    await this.#serve.start();
  }

  /** Kill the subprocess and release the port. */
  async shutdown(): Promise<void> {
    await this.#serve.stop();
  }

  /** POST a request to the control API and unwrap its result, mapping coded errors to types. */
  async #request(body: Record<string, unknown>): Promise<string> {
    const baseUrl = await this.#serve.start();
    const res = await fetch(`${baseUrl}/api/v1/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as RequestResponse;
    if (json.success && json.result !== undefined) return json.result;

    const message = json.error ?? `request failed (HTTP ${res.status})`;
    if (json.code === SignerErrorCode.WrongWalletAddress) {
      throw new WrongWalletAddressError(message);
    }
    throw new Error(message);
  }

  /** Connect a wallet, returning the connected address. */
  async connectWallet(options?: { chainId?: number; address?: string }): Promise<string> {
    return this.#request({
      type: "connect",
      chainId: options?.chainId ?? this.#defaultChainId,
      address: options?.address,
    });
  }

  /** Send a transaction (or contract call), returning the tx hash. */
  async sendTransaction(params: SendTransactionParams): Promise<string> {
    return this.#request({
      type: "send_transaction",
      ...params,
      chainId: params.chainId ?? this.#defaultChainId,
    });
  }

  /** `personal_sign` a message, returning the signature. */
  async signMessage(params: SignMessageParams): Promise<string> {
    return this.#request({
      type: "sign_message",
      ...params,
      chainId: params.chainId ?? this.#defaultChainId,
    });
  }

  /** Sign EIP-712 typed data, returning the signature. */
  async signTypedData(params: SignTypedDataParams): Promise<string> {
    return this.#request({
      type: "sign_typed_data",
      ...params,
      chainId: params.chainId ?? this.#defaultChainId,
    });
  }
}
