/**
 * browser-web3-signer TypeScript binding.
 *
 * A thin client over the Rust `serve` control API: it spawns and supervises the
 * `browser-web3-signer serve` subprocess (which owns the bridge and the persistent browser tab)
 * and drives it over HTTP, exposing a {@link WalletSignerClient}.
 *
 * The viem transport and account are exported from `browser-web3-signer/viem` instead, so this
 * entry point stays free of the optional `viem` peer dependency.
 */

export {
  findWrongWalletAddressError,
  WalletSignerClient,
  WrongWalletAddressError,
  SignerErrorCode,
  type WalletSignerClientOptions,
  type SendTransactionParams,
  type SignMessageParams,
  type SignTypedDataParams,
} from "./client.ts";

export { ServeProcess, type Chain, type ServeProcessOptions } from "./serve-process.ts";
