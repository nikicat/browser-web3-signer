/**
 * Deno smoke test for the TS binding: exercises the `Deno.Command` spawn path — the runtime
 * surface the Node suite can't reach. Runs with a *restricted* env permission (`--ignore-env`,
 * no allowlist) on purpose: the fake wallet needs PATH etc. to launch, so this fails if the
 * subprocess is ever spawned with the permission-filtered environment instead of the real one.
 *
 * Invoked from ts/ as `npm run test:deno` (see package.json) after building the workspace
 * binary with `cargo build`. Named outside the `*.test.ts` glob so `node --test` skips it.
 */

import { fileURLToPath } from "node:url";

import { WalletSignerClient } from "../src/client.ts";

// Type-only shadow for tsc, which checks this file without Deno's globals.
declare const Deno: { test(name: string, fn: () => Promise<void>): void };

const FAKE_WALLET = fileURLToPath(new URL("./fake-wallet.mjs", import.meta.url));
const FAKE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

Deno.test("connect + sign through the serve subprocess (Deno.Command spawn path)", async () => {
  await using client = new WalletSignerClient("evm", { browser: FAKE_WALLET, defaultChainId: 1 });

  const address = await client.connectWallet({ chainId: 1 });
  if (address.toLowerCase() !== FAKE_ADDRESS.toLowerCase()) {
    throw new Error(`connected ${address}, expected ${FAKE_ADDRESS}`);
  }

  const sig = await client.signMessage({ message: "deno smoke", chainId: 1 });
  if (!/^0x[0-9a-f]+$/i.test(sig)) {
    throw new Error(`unexpected signature: ${sig}`);
  }
});
