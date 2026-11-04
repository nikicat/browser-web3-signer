# ADR 0006: One shared approval-page core, thin per-chain adapters, no build step

- **Status:** accepted
- **Date:** 2026-07-02

## Context

The EVM and TRON approval pages duplicated the bridge protocol, the app state machine and the
error contract. Fixes landed in one page and not the other: the "don't `completeError` on a
recoverable catch" rule and the settled-result handling reached `evm.html` but not `tron.html`.

The pages must stay JavaScript, because they run in the wallet's page context. They are embedded
in the binary with `include_str!`.

## Decision

The shared logic lives once in
[`app-core.js`](../../crates/browser-web3-signer-core/web/app-core.js), owned by the core crate
and served at `GET /app-core.js` by every bridge (CLI, `serve`, e2e harnesses). Shared styles
are served the same way from `app-core.css`. Each chain page is its markup and brand colour plus
a thin adapter passed to `WalletSignerCore.init(adapter)`: the wallet operations, wallet
presence and identity, address matching, and the chain-specific parts of the presentation.
The core owns the flow; the adapter owns the chain.

The code is hand-written JavaScript with no build step, so `include_str!` works in the
Node-less CI build.

## Alternatives considered

- **A copy of the logic per page:** the status quo, and the source of the divergence above.
- **TypeScript with a build step:** type safety at the cost of a toolchain in the Rust build.
  Still open: [ADR 0009](0009-approval-pages-in-typescript.md).

## Consequences

- A fix to the protocol or the error contract applies to every chain at once.
- The account-change flow ([ADR 0005](0005-evm-account-change.md)) lives in the core, with
  chain hooks in the adapters.
