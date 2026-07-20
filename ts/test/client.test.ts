/** Unit tests for pure client helpers (no subprocess needed). */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  findWrongWalletAddressError,
  WalletSignerClient,
  WrongWalletAddressError,
} from "../src/client.ts";

describe("findWrongWalletAddressError", () => {
  test("returns the error itself when given directly", () => {
    const err = new WrongWalletAddressError("wrong account");
    assert.equal(findWrongWalletAddressError(err), err);
  });

  test("finds the error buried under wrap layers", () => {
    const inner = new WrongWalletAddressError("wrong account");
    const wrapped = new Error("request failed", {
      cause: new Error("transport error", { cause: inner }),
    });
    assert.equal(findWrongWalletAddressError(wrapped), inner);
  });

  test("returns null for unrelated errors", () => {
    assert.equal(findWrongWalletAddressError(new Error("boom")), null);
    assert.equal(
      findWrongWalletAddressError(new Error("outer", { cause: new Error("inner") })),
      null,
    );
  });

  test("returns null for non-error values", () => {
    assert.equal(findWrongWalletAddressError(undefined), null);
    assert.equal(findWrongWalletAddressError("WrongWalletAddressError"), null);
    assert.equal(findWrongWalletAddressError({ name: "WrongWalletAddressError" }), null);
  });
});

describe("WalletSignerClient disposal", () => {
  test("await using disposes an unstarted client without spawning", async () => {
    // Nothing was started, so dispose must be a no-op that still resolves.
    await using client = new WalletSignerClient("evm", { binPath: "/nonexistent" });
    void client;
  });
});
