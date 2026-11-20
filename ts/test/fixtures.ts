import type {
  SendTransactionParams,
  SignMessageParams,
  SignTypedDataParams,
  WalletSignerClient,
} from "../src/client.ts";

export const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const MAIL = {
  domain: { name: "Mail" },
  types: {
    EIP712Domain: [{ name: "name", type: "string" }],
    Mail: [{ name: "to", type: "address" }],
  },
  primaryType: "Mail",
  message: { to: ADDRESS },
} as const;

/** A signer stub with the arrays it records each connect, transaction and signature into. */
export function recordingSigner() {
  const connects: ({ chainId?: number } | undefined)[] = [];
  const sent: SendTransactionParams[] = [];
  const signed: (SignMessageParams | SignTypedDataParams)[] = [];
  const signer = {
    connectWallet: (options?: { chainId?: number }) =>
      (connects.push(options), Promise.resolve(ADDRESS)),
    sendTransaction: (params: SendTransactionParams) =>
      (sent.push(params), Promise.resolve("0x" + "ab".repeat(32))),
    signMessage: (params: SignMessageParams) => (signed.push(params), Promise.resolve("0x")),
    signTypedData: (params: SignTypedDataParams) => (signed.push(params), Promise.resolve("0x")),
  } as unknown as WalletSignerClient;
  return { signer, connects, sent, signed };
}
