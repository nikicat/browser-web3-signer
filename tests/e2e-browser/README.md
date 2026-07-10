# Browser e2e tests

Playwright tests that drive a **mock wallet** against the **real Rust bridge**, exercising the
full browser interaction for both chains: connect, sign message / typed data, send transaction,
trigger / deploy contract (TRON), reject, cancel, address-mismatch, and not-found. They pin the
embedded approval UIs (`crates/browser-web3-signer-{evm,tron}/web/*.html`) against the wire contract the Rust engine
serves.

- **EVM** — `evm/` (13 tests), driven by the `evm-harness` binary + an EIP-6963 / `window.ethereum` mock.
- **TRON** — `tron/` (19 tests), driven by the `tron-harness` binary + a TronLink (`window.tronWeb`) mock.

## How it works

```
Playwright (Node)                     Rust {evm,tron}-harness binary
  │  spawn ────────────────────────►  Engine<R> + embedded HTML
  │  ◄──── prints bound port           + test-only routes:
  │                                       POST /api/test/create-request  → {id}
  │  POST /api/test/create-request       GET  /api/test/result/:id       → outcome | {pending}
  │  navigate browser to /connect|/sign/:id
  │  inject mock wallet (provider globals)
  │  click Approve/Reject  ──► browser POSTs /api/complete/:id ──► engine resolves
  │  GET /api/test/result/:id  ◄── cached outcome
```

Each harness mounts two **test-only** endpoints (feature-gated behind `e2e`, never shipped) onto
the real bridge via the `Engine::start_with` / `build_router_with` extension point — the same
hook the planned daemon uses for its control API. Because the production routes (`/api/pending`,
`/api/complete`, the SPA fallback) and the embedded HTML are unchanged, the browser half of each
test is identical to what a real wallet sees.

The harness plumbing is generic over the chain's request type and shared in
[`common/harness.rs`](../../crates/browser-web3-signer/src/bin/common/harness.rs); each
`{evm,tron}_harness.rs` binary supplies only a `build_request` mapping the test JSON into its
request enum.

The result endpoint bridges a semantic gap: the engine delivers a result through a `oneshot`
(consumed on read), but the test needs to *peek* repeatedly. The harness spawns a task that
awaits the future and caches the outcome; `/api/test/result/:id` reads from that cache, falling
back to `{pending:true}` while the request is live in the store.

## Running

From the workspace root:

```sh
just e2e-setup   # one-time: npm install + Chromium download
just e2e         # builds both harnesses, then runs Playwright (EVM + TRON)
```

Or directly:

```sh
cargo build --bin evm-harness --bin tron-harness --features e2e
cd tests/e2e-browser && npm install && npx playwright install chromium && npm test
```

## Layout

```
fixtures/harness.mts          shared driver: spawn a harness binary, expose the /api/test/* API
evm/wallet-flow.spec.ts       EVM suite (ported verbatim from mcp-wallet-signer-mod)
evm/fixtures/mock-wallet.mts  EIP-6963 / window.ethereum mock (verbatim)
evm/fixtures/test-server.mts  binds the shared driver to `evm-harness`
tron/wallet-flow.spec.ts      TRON suite (ported verbatim)
tron/fixtures/mock-wallet.mts TronLink / window.tronWeb mock (verbatim apart from TEST_ADDRESS)
tron/fixtures/test-server.mts binds the shared driver to `tron-harness`
```

The specs and `mock-wallet.mts` files are copied unchanged from the reference; only the
`test-server.mts` shims differ (they spawn a Rust process instead of an in-process Deno server).

## Port-specific divergences from the reference

- **EVM address casing**: the Rust `Address` normalizes to lowercase hex at the request boundary
  (the UI matches case-insensitively), so the rendered required-address is lowercase rather than
  the checksummed input. The relevant assertion compares case-insensitively.
- **TRON address validation**: `TronAddress` validates Base58Check on construction, so any
  request carrying an `address` must use a checksum-valid one. The reference's placeholder
  `TEST_ADDRESS` and `wrongAddress` literals were not valid; both are replaced with real
  addresses (see the comments in `tron/fixtures/mock-wallet.mts` and `tron/wallet-flow.spec.ts`).
