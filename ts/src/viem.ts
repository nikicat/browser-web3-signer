/**
 * viem integration for browser-web3-signer: a viem transport and account backed by the
 * browser wallet.
 *
 * This lives outside the package root so that importing {@link WalletSignerClient} does not
 * pull in `viem`. viem is an optional peer dependency needed only by this entry point —
 * consumers that just drive the wallet over the control API never install it.
 *
 * ```ts
 * import { WalletSignerClient } from "browser-web3-signer";
 * import { connectWalletViem } from "browser-web3-signer/viem";
 * ```
 */

export { walletSignerTransport, type WalletSignerTransportOptions } from "./transport.ts";

export {
  connectWalletViem,
  type ConnectWalletViemOptions,
  type ViemBrowserAccount,
} from "./viem-account.ts";
