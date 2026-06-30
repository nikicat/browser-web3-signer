# Browser e2e tests

Playwright tests that drive a **mock wallet** against the **real Rust bridge**, exercising the
full browser interaction: connect, sign message / typed data, send transaction, reject, cancel,
address-mismatch, and not-found. They pin the embedded approval UI (`web/evm.html`) against the
wire contract the Rust engine serves.

## How it works

```
Playwright (Node)                     Rust e2e-harness binary
  │  spawn ────────────────────────►  EvmSigner + Engine + embedded HTML
  │  ◄──── prints bound port           + test-only routes:
  │                                       POST /api/test/create-request  → {id}
  │  POST /api/test/create-request       GET  /api/test/result/:id       → outcome | {pending}
  │  navigate browser to /connect|/sign/:id
  │  inject mock wallet (EIP-6963 + window.ethereum)
  │  click Approve/Reject  ──► browser POSTs /api/complete/:id ──► engine resolves
  │  GET /api/test/result/:id  ◄── cached outcome
```

The harness ([`crates/browser-web3-signer/src/bin/e2e_harness.rs`](../../crates/browser-web3-signer/src/bin/e2e_harness.rs))
mounts two **test-only** endpoints (feature-gated behind `e2e`, never shipped) onto the real
bridge via the `Engine::start_with` / `build_router_with` extension point — the same hook the
planned daemon uses for its control API. Because the production routes (`/api/pending`,
`/api/complete`, the SPA fallback) and the embedded HTML are unchanged, the browser half of each
test is identical to what a real wallet sees.

The result endpoint bridges a semantic gap: the engine delivers a result through a `oneshot`
(consumed on read), but the test needs to *peek* repeatedly. The harness spawns a task that
awaits the future and caches the outcome; `/api/test/result/:id` reads from that cache, falling
back to `{pending:true}` while the request is live in the store.

## Running

From the workspace root:

```sh
just e2e-setup   # one-time: npm install + Chromium download
just e2e         # builds the harness, then runs Playwright
```

Or directly:

```sh
cargo build --bin e2e-harness --features e2e
cd tests/e2e-browser && npm install && npx playwright install chromium && npm test
```

## Files

- `wallet-flow.spec.ts` — the test suite (ported from `mcp-wallet-signer-mod`).
- `fixtures/mock-wallet.mts` — injects a fake EIP-1193 / EIP-6963 provider returning canned
  signatures. Pure browser JS; unaware the server is Rust. Copied verbatim from the reference.
- `fixtures/test-server.mts` — spawns the harness binary and exposes the `/api/test/*` helpers.
  The only file that differs from the reference (spawns a Rust process instead of an in-process
  Deno server).

## Port-specific divergences from the reference

- **Address casing**: the Rust `Address` domain type normalizes to lowercase hex at the request
  boundary (the UI matches case-insensitively), so the rendered required-address is lowercase
  rather than the checksummed input. The relevant assertion compares case-insensitively.
