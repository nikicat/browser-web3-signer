---
status: todo
tags: [btc]
---
# Bitcoin: Sats Connect / WBIP wallets (Xverse, Magic Eden), then Phantom

## Goal
Add the next Bitcoin wallet family beside Unisat and Leather: Sats Connect / WBIP (Xverse,
Magic Eden), then Phantom. Done = connect, send, sign-PSBT, sign-message work through the
existing page core with a per-wallet driver, covered by the mock-wallet e2e.

## Decisions
- Ordering per ADR 0001 (`docs/adr/0001-bitcoin-support.md`): Sats Connect first; Phantom
  last because it has no send.

## Next
Check the Sats Connect / WBIP API against the wallet's source (not docs) before designing the
driver — see the "check source, not the EIP" lesson in `docs/wallet-account-change.md`.
