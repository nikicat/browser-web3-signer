/**
 * browser-web3-signer TypeScript binding.
 *
 * A thin client over the Rust `serve` control API: it spawns and supervises the
 * `browser-web3-signer serve` subprocess (which owns the bridge and the persistent browser tab)
 * and drives it over HTTP, exposing a {@link WalletSignerClient} plus a viem transport + account.
 */

export {
  WalletSignerClient,
  WrongWalletAddressError,
  SignerErrorCode,
  type WalletSignerClientOptions,
  type SendTransactionParams,
  type SignMessageParams,
  type SignTypedDataParams,
} from "./client.ts";

export { ServeProcess, type Chain, type ServeProcessOptions } from "./serve-process.ts";

export { walletSignerTransport, type WalletSignerTransportOptions } from "./transport.ts";

export {
  connectWalletViem,
  type ConnectWalletViemOptions,
  type ViemBrowserAccount,
} from "./viem-account.ts";
