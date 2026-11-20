import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { connectWalletViem } from "../src/viem-account.ts";

import { ADDRESS, MAIL, recordingSigner } from "./fixtures.ts";

async function signBoth(chainId?: number) {
  const { signer, connects, signed } = recordingSigner();
  const { account } = await connectWalletViem(signer, { chainId });
  await account.signMessage({ message: "hello" });
  await account.signTypedData(MAIL);
  return { connects, signed };
}

describe("connectWalletViem", () => {
  test("connects and signs on the configured chain", async () => {
    const { connects, signed } = await signBoth(43114);
    assert.deepEqual(connects, [{ chainId: 43114 }]);
    assert.deepEqual(signed, [
      { message: "hello", address: ADDRESS, chainId: 43114 },
      { ...MAIL, address: ADDRESS, chainId: 43114 },
    ]);
  });

  test("passes no chain when none is configured", async () => {
    const { connects, signed } = await signBoth();
    assert.deepEqual(connects, [{}]);
    assert.deepEqual(signed, [
      { message: "hello", address: ADDRESS },
      { ...MAIL, address: ADDRESS },
    ]);
  });
});
