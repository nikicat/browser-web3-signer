---
status: todo
tags: [ts, viem]
---
# Leftovers from the unsmell run of 2026-11-20 (viem transport: chainId, read provider)

## Goal
Smells in the TS viem layer that the run did not fix, because they sit on lines the change did not
touch or need a decision. Done = each entry below is fixed or dropped. Run record:
`.git/unsmell/20261120-102712/` (findings `r12`, `r13`, `s5`).

## Next
- `ts/src/transport.ts`, `eth_chainId` with no `chainId`: throws a plain `Error`, which viem wraps
  in `UnknownRpcError`, while `NoReadRpcError` is a viem `BaseError` that callers catch directly.
  Give it a named `BaseError` subclass too, so both setup errors reach callers the same way.
- `ts/src/viem-account.ts`, `ViemBrowserAccount`: viem's `Account` type rejects a `json-rpc`
  account that also has `signMessage` / `signTypedData`, so it cannot be passed to
  `createWalletClient({ account })` without a cast. Find a type viem accepts (or document the cast).
- `ts/src/viem-account.ts`, the module doc narrates history ("Ported from the reference…") and
  mechanism. Replace with the decision it rests on, cited (ADR 0002), or delete it.
- Decide whether to adopt zod for the inputs the package does not control: the bridge's HTTP
  replies in `ts/src/client.ts` (now cast with `as`). The typed-data payload already goes through
  viem's `validateTypedData`. zod would be a new runtime dependency of a package that has none.
