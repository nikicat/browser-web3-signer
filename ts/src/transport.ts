/**
 * A viem transport that sends the wallet methods to the browser wallet through a
 * {@link WalletSignerClient}. Every other JSON-RPC call goes to the caller's own RPC, since reads
 * belong to the caller (`docs/adr/0008-no-read-side.md`).
 */

import {
  BaseError,
  custom,
  hexToBigInt,
  hexToBytes,
  hexToNumber,
  http,
  validateTypedData,
} from "viem";
import type {
  CustomTransport,
  EIP1193Parameters,
  Hex,
  PublicRpcSchema,
  Quantity,
  RpcTransactionRequest,
  WalletRpcSchema,
} from "viem";

import type {
  SendTransactionParams,
  SignableMessage,
  SignTypedDataParams,
  WalletSignerClient,
} from "./client.ts";

export interface ReadProvider {
  request(args: EIP1193Parameters): Promise<unknown>;
}

export type ReadSource =
  | {
      /** A JSON-RPC endpoint URL, reached over HTTP. */
      rpcUrl?: string;
      provider?: never;
    }
  | {
      provider: ReadProvider;
      rpcUrl?: never;
    };

/** Thrown when a chain-reading call reaches a transport given neither `rpcUrl` nor `provider`. */
export class NoReadRpcError extends BaseError {
  override readonly name = "NoReadRpcError";
  constructor(method: string) {
    super(
      `No rpcUrl or provider configured for read method ${method}. Pass one in transport options.`,
    );
  }
}

/** Options for {@link walletSignerTransport}. */
export type WalletSignerTransportOptions = ReadSource & {
  /**
   * The chain that the wallet switches to before it signs or sends, and that `eth_chainId` returns.
   * A transaction's own chain id wins. When this is unset, the wallet methods use
   * `WalletSignerClientOptions.defaultChainId`, and `eth_chainId` errors.
   */
  chainId?: number;
};

export function walletSignerTransport(
  signer: WalletSignerClient,
  options?: WalletSignerTransportOptions,
): CustomTransport {
  const chain = chainParam(options?.chainId);
  const read = readerFor(options);
  return custom(
    {
      async request({ method, params }: TransportRequest) {
        switch (method) {
          case "personal_sign": {
            const [messageHex, address] = params;
            return signer.signMessage({ message: signableFromHex(messageHex), address, ...chain });
          }

          case "eth_sendTransaction": {
            const [tx] = params;
            return signer.sendTransaction({ ...chain, ...sendParamsFromRpc(tx) });
          }

          case "eth_signTypedData_v4": {
            const [address, typedDataJson] = params;
            const typedData = parseTypedData(typedDataJson);
            return signer.signTypedData({ ...typedData, address, ...chain });
          }

          case "eth_chainId": {
            if (options?.chainId === undefined) {
              throw new Error("eth_chainId requested but no chainId configured on the transport");
            }
            return `0x${options.chainId.toString(16)}`;
          }

          default:
            return read({ method, params });
        }
      },
    },
    { retryCount: 0 },
  );
}

export function chainParam(chainId: number | undefined): { chainId?: number } {
  return chainId === undefined ? {} : { chainId };
}

type TransportRequest = EIP1193Parameters<WalletRpcSchema> | EIP1193Parameters<PublicRpcSchema>;

/**
 * A request can carry a chain id when a caller other than viem sends it, and viem's own type
 * leaves that field out.
 */
type RpcSendRequest = RpcTransactionRequest & { chainId?: Quantity };

function sendParamsFromRpc(tx: RpcSendRequest): SendTransactionParams {
  const sendParams: SendTransactionParams = {};
  if (tx.to) sendParams.to = tx.to;
  if (tx.from) sendParams.from = tx.from;
  if (tx.data) sendParams.data = tx.data;
  if (tx.value) sendParams.value = decimal(tx.value);
  if (tx.gas) sendParams.gasLimit = decimal(tx.gas);
  if (tx.maxFeePerGas) sendParams.maxFeePerGas = decimal(tx.maxFeePerGas);
  if (tx.maxPriorityFeePerGas) sendParams.maxPriorityFeePerGas = decimal(tx.maxPriorityFeePerGas);
  if (tx.chainId) sendParams.chainId = hexToNumber(tx.chainId);
  return sendParams;
}

function decimal(quantity: Quantity): string {
  return hexToBigInt(quantity).toString();
}

/**
 * Returns the typed data in the JSON text of an `eth_signTypedData_v4` request. Errors with a
 * `SyntaxError` when the text is not JSON, and with one of viem's `BaseError`s when the domain,
 * the primary type or the message does not match the declared types.
 */
function parseTypedData(json: string): SignTypedDataParams {
  const { domain, types, primaryType, message } = JSON.parse(json);
  validateTypedData({ domain, types, primaryType, message });
  return { domain, types, primaryType, message };
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

function readerFor(options?: WalletSignerTransportOptions): ReadProvider["request"] {
  const provider = options?.provider;
  if (provider) return (args) => provider.request(args);
  const rpcUrl = options?.rpcUrl;
  if (!rpcUrl) {
    return async ({ method }) => {
      throw new NoReadRpcError(method);
    };
  }
  return http(rpcUrl, { retryCount: 0 })({}).request;
}
