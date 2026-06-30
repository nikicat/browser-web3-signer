/**
 * A viem-compatible hybrid account backed by the browser wallet (via the Rust bridge).
 * Ported from the reference `viem-account.ts`, retargeted at {@link WalletSignerClient}.
 *
 * The account is type `"json-rpc"` so viem routes `eth_sendTransaction` through the transport
 * (which forwards to the wallet); `signMessage` / `signTypedData` are also available directly.
 */

import type { Address, CustomSource, CustomTransport, Hex } from "viem";

import type { SignTypedDataParams, WalletSignerClient } from "./client.ts";
import { walletSignerTransport, type WalletSignerTransportOptions } from "./transport.ts";

/** A viem hybrid account: `json-rpc` send path + direct message/typed-data signing. */
export interface ViemBrowserAccount {
  address: Address;
  type: "json-rpc";
  signMessage: CustomSource["signMessage"];
  signTypedData: CustomSource["signTypedData"];
  signTransaction: never;
}

/** Options for {@link connectWalletViem}. */
export interface ConnectWalletViemOptions extends WalletSignerTransportOptions {
  /** Pre-connected address — skips the `connectWallet()` browser prompt if provided. */
  address?: Address;
}

/**
 * Connect to a browser wallet and return a viem hybrid account + custom transport, both bound to
 * the given client. With no `address`, prompts a connect via the browser first.
 */
export async function connectWalletViem(
  signer: WalletSignerClient,
  options?: ConnectWalletViemOptions,
): Promise<{ account: ViemBrowserAccount; transport: CustomTransport }> {
  const address = (options?.address ?? (await signer.connectWallet())) as Address;

  const signMessage: CustomSource["signMessage"] = async ({ message }) => {
    let msg: string;
    if (typeof message === "string") {
      msg = message;
    } else {
      msg = typeof message.raw === "string" ? message.raw : new TextDecoder().decode(message.raw);
    }
    return (await signer.signMessage({ message: msg, address })) as Hex;
  };

  // viem's CustomSource["signTypedData"] uses heavily generic conditional types that TS can't
  // prove assignable inside the generic callback; the reference casts here too.
  const signTypedData: CustomSource["signTypedData"] = async (params) => {
    return (await signer.signTypedData({
      ...(params as unknown as SignTypedDataParams),
      address,
    })) as Hex;
  };

  const account: ViemBrowserAccount = {
    address,
    type: "json-rpc",
    signMessage,
    signTypedData,
    signTransaction: undefined as never,
  };

  return { account, transport: walletSignerTransport(signer, options) };
}
