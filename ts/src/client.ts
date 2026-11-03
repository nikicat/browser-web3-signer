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

/**
 * Find a {@link WrongWalletAddressError} anywhere in `err`'s `cause` chain, or null.
 *
 * Signing stacks wrap transport errors in several layers (viem alone adds two) — use this at the
 * top level of a CLI or request handler to surface the actionable "switch wallet account" message
 * instead of the outermost wrapper.
 */
export function findWrongWalletAddressError(err: unknown): WrongWalletAddressError | null {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e instanceof WrongWalletAddressError) return e;
  }
  return null;
}

/** The control API's response envelope (`{success, result}` or `{success:false, error, code?}`). */
interface RequestResponse {
  success: boolean;
  result?: string;
  error?: string;
  code?: string;
}

/** POST a request to the control API and unwrap its result, mapping coded errors to types. */
async function controlRequest(serve: ServeProcess, body: Record<string, unknown>): Promise<string> {
  const baseUrl = await serve.start();
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

/** Options for {@link WalletSignerClient}. */
export interface WalletSignerClientOptions extends ServeProcessOptions {
  /** Default chain id (EVM) / network — sent when a request omits one. */
  defaultChainId?: number;
}

/** Parameters for {@link WalletSignerClient.sendTransaction}. */
export interface SendTransactionParams {
  /** The recipient or contract; without it, the tx deploys `data` as a new contract,
   * and the signer refuses one without `data`. */
  to?: string;
  from?: string;
  value?: string;
  data?: string;
  chainId?: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

/**
 * What `personal_sign` signs, in viem's shape: text (signed as its UTF-8 bytes), or `{ raw }`
 * for exact bytes such as a hash a Safe expects signed as-is.
 */
export type SignableMessage = string | { raw: `0x${string}` };

/** Parameters for {@link WalletSignerClient.signMessage}. */
export interface SignMessageParams {
  message: SignableMessage;
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
export class WalletSignerClient implements AsyncDisposable {
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

  /** `await using client = new WalletSignerClient(...)` — {@link shutdown} on scope exit. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  async #request(body: Record<string, unknown>): Promise<string> {
    return controlRequest(this.#serve, body);
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

/** A Bitcoin network, as the bridge names it; "testnet3" is another name for "testnet". */
export type BtcNetwork = "mainnet" | "testnet" | "testnet3" | "testnet4" | "signet" | "regtest";

/** Options for {@link BtcSignerClient}. */
export interface BtcSignerClientOptions extends ServeProcessOptions {
  /** Sent when a request omits a network; else `serve`'s (BROWSER_WEB3_BTC_NETWORK or mainnet). */
  defaultNetwork?: BtcNetwork;
}

/** Parameters for {@link BtcSignerClient.sendTransfer}. */
export interface BtcSendTransferParams {
  to: string;
  /** Amount in sats. */
  amount: bigint | number;
  /** Expected sender; a mismatch is rejected. */
  from?: string;
  /** Fee-rate hint in sat/vB. */
  feeRate?: number;
  network?: BtcNetwork;
}

/** Result of {@link BtcSignerClient.connectWallet}: the connected wallet account. */
export interface BtcAccount {
  /** The account's address, on the request's network. */
  address: string;
  /**
   * The compressed key that signs for the account, in hex. A caller names its x-only form (the
   * last 32 bytes) in a Taproot script leaf for the wallet to sign through it.
   */
  publicKey: string;
}

/** Parameters for {@link BtcSignerClient.signPsbt}. */
export interface BtcSignPsbtParams {
  /** The PSBT, hex or base64 (e.g. bitcoinjs-lib's `psbt.toHex()`). */
  psbt: string;
  /**
   * Input indexes to sign; omitted means every input the wallet owns. An input that lists a
   * Taproot leaf script is signed through the leaf, with the account's untweaked key, and only
   * when listed here.
   */
  signInputs?: number[];
  /** Finalize the signed inputs. Leather finalizes only when broadcasting. */
  finalize?: boolean;
  /** Broadcast through the wallet after signing (implies `finalize`). */
  broadcast?: boolean;
  /** Expected signer; a mismatch is rejected. */
  from?: string;
  network?: BtcNetwork;
}

/** Result of {@link BtcSignerClient.signPsbt}. */
export interface BtcSignedPsbt {
  /** The signed PSBT, as the wallet returned it (hex for Unisat and Leather). */
  psbt: string;
  /** The broadcast txid; present only when the request broadcast. */
  txid?: string;
}

/** Parameters for {@link BtcSignerClient.signMessage}. */
export interface BtcSignMessageParams {
  message: string;
  /** Address to sign with. */
  address?: string;
  /** Signature scheme; the bridge defaults to `bip322`. */
  protocol?: "bip322" | "ecdsa";
  network?: BtcNetwork;
}

/**
 * Bitcoin over a managed `serve --chain btc` subprocess (Unisat, Leather). `serve` checks each
 * result against its request before returning it: the address is on the request's network, a
 * signed PSBT is for the same transaction, and a broadcast txid matches it.
 */
export class BtcSignerClient implements AsyncDisposable {
  readonly #serve: ServeProcess;
  readonly #defaultNetwork?: BtcNetwork;

  constructor(options?: BtcSignerClientOptions) {
    this.#serve = new ServeProcess("btc", options);
    this.#defaultNetwork = options?.defaultNetwork;
  }

  /** Start the subprocess (idempotent). Called automatically on first request. */
  async start(): Promise<void> {
    await this.#serve.start();
  }

  /** Kill the subprocess and release the port. */
  async shutdown(): Promise<void> {
    await this.#serve.stop();
  }

  /** `await using client = new BtcSignerClient(...)` — {@link shutdown} on scope exit. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  #request<P extends { network?: BtcNetwork }>(type: string, params: P): Promise<string> {
    const network = params.network ?? this.#defaultNetwork;
    return controlRequest(this.#serve, { type, ...params, network });
  }

  /** Connect the wallet, returning its account. */
  async connectWallet(options?: { network?: BtcNetwork; address?: string }): Promise<BtcAccount> {
    const { address, publicKey } = JSON.parse(await this.#request("connect", { ...options })) as BtcAccount;
    return { address, publicKey };
  }

  /** Pay one address (the wallet selects coins, signs and broadcasts), returning the txid. */
  async sendTransfer(params: BtcSendTransferParams): Promise<string> {
    return this.#request("send_transfer", {
      ...params,
      amount: params.amount.toString(),
      feeRate: params.feeRate?.toString(),
    });
  }

  /** Sign a PSBT, returning it (and the txid, when broadcast). */
  async signPsbt(params: BtcSignPsbtParams): Promise<BtcSignedPsbt> {
    const { psbt, txid } = JSON.parse(await this.#request("sign_psbt", params)) as BtcSignedPsbt;
    return txid === undefined ? { psbt } : { psbt, txid };
  }

  /** Sign a text message, returning the base64 signature. */
  async signMessage(params: BtcSignMessageParams): Promise<string> {
    return this.#request("sign_message", params);
  }
}
