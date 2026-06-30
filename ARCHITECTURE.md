# Architecture

This document describes the design of `browser-web3-signer` and the rationale behind the
decisions that shaped it. It supersedes the original planning notes.

## Goal & context

Reimplement, in Rust, the browser-signing capability of `mcp-wallet-signer` (a Deno/TS
project), with two changes of intent:

- **The CLI is the interface for agents** — MCP is dropped. An agent runs a command and
  reads stdout.
- **The core is a reusable library**, so the capability can be embedded from other
  languages (via a planned local daemon API) and wrapped by TypeScript adaptors.

The defining property is preserved: **the private key never leaves the user's browser
wallet.** This process only ferries a request to a local page and reads the signed result
back. The HTTP bridge binds `127.0.0.1` exclusively.

## Workspace layout

```
crates/
  browser-web3-signer-core/   chain-agnostic engine (lib)
  browser-web3-signer-evm/    EVM requests, domain types, embedded UI, alloy reads (lib)
  browser-web3-signer-tron/   TRON requests, domain types, embedded UI, TronGrid reads (lib)
  browser-web3-signer/        the `browser-web3-signer` binary (one-shot CLI)
web/
  evm.html / tron.html        self-contained vanilla-JS approval UIs (embedded via include_str!)
ts/                           TypeScript adaptors (planned)
```

Edition 2024, MSRV 1.95.

## Request lifecycle

```
engine.prepare(request)            create a UUID-keyed pending entry, build the approval URL
   │                               (does NOT open a browser)
   ├─► browser opens /sign/:id  ── GET /api/pending/:id ──► request JSON
   │                               wallet signs / sends
   └─◄ ResultFuture resolves   ◄── POST /api/complete/:id  {success,result|error,code}
```

`Engine::submit` is the convenience path (prepare + open + await) for the library/daemon;
the CLI uses `prepare` so it can print the URL before opening. Requests time out after
5 minutes; a timed-out or cancelled entry is removed so the bridge stops serving it.

The HTTP bridge (axum) exposes exactly: `GET /api/pending/:id`, `POST /api/complete/:id`,
`GET /api/health`, and a fallback that serves the embedded SPA for any other path (the
in-page router dispatches `/connect/:id` and `/sign/:id`). CORS mirrors the reference
(`*`, GET/POST/OPTIONS). The request/result JSON shapes and endpoint paths are kept
**byte-compatible with the reference UI**, so the ported HTML works unchanged and future
TS adaptors interoperate.

`build_router_with` / `Engine::start_with` add an **extension point**: a caller can merge its
own routes onto the core bridge, sharing the same `PendingStore`. Both the planned daemon (its
`/api/v1` control API + SSE) and the e2e test harness (`/api/test/*`) hook in here rather than
forking the router. The merged routes carry their own state and middleware; the core CORS layer
applies only to the core routes.

## Core abstractions (`browser-web3-signer-core`)

- **`PendingStore<R>`** — `Mutex<HashMap<Uuid, (request, oneshot::Sender)>>`. `create`
  returns a receiver; `complete` fires it; `cancel`/timeout drop the entry.
- **`Engine<R>`** — owns the store + the lazily-started bridge. Generic over a chain's
  request type `R: Request` (a `Serialize` enum that also yields its `id`).
- **HTTP bridge** — `build_router` + handlers, generic over `R`.
- **Browser launcher** — `opener` crate, honoring `$BROWSER`; `BrowserChoice` of
  Default / Named / Print.
- **Shared byte types** — `TxHash` (32 bytes), `Signature` (ECDSA bytes), `HexData`
  (calldata/memo). These are identical across EVM and TRON (both secp256k1/keccak), so they
  live here; only address encoding is chain-specific.
- **`RequestMeta`** — the per-request fields common to every chain (`{ id }`), flattened
  into each request's JSON; one source of truth and a place to grow.
- **`Url`** — `url::Url` re-exported so every crate shares one URL type.

## Key decisions & rationale

### Domain types everywhere; no algebraic blindness

Values are modelled with precise types, never bare `String`/`u64`/`bool` where a meaningful
type exists. A value that "is an address" cannot be confused with one that "is a tx hash".
Examples: `Address`, `Wei`, `ChainId`, `CallData` (EVM); `TronAddress`, `Sun`, `EnergyLimit`,
`Percentage`, `TronNetwork` (TRON); `Port`, `TxHash`, `Signature`, `HexData`, `Url` (shared).
Each parses/validates at construction (a bad address fails at the boundary, not deep in a
wallet call) and serializes to the exact wire shape the UI expects. Genuinely open-ended
data (EIP-712 `domain`/`types`/`message`) stays as `serde_json::Value` inside a named
`TypedData` container. The transport boundary (`Engine`) returns a raw `String` — the browser
literally posts a string whose meaning only the chain layer knows — and the chain layer
parses it into the right type immediately.

### `Port` / `BindPort`, and the preferred-port-with-fallback model

A port is a `Port` (non-zero `NonZeroU16`); "use an ephemeral port" is a distinct
`BindPort::Ephemeral` rather than the magic value `0`. The configured port is *preferred*,
not mandatory:

- **One-shot commands** try the preferred port so the browser origin (`127.0.0.1:3847`)
  stays stable across invocations — that's what lets a wallet skip the reconnect prompt. If
  it's already in use, they fall back to an OS-assigned ephemeral port instead of failing,
  so concurrent commands never collide.
- A future **daemon** will own the stable port; concurrency among apps is handled there by a
  request queue, not by many listeners.

### `Shared<T>` instead of scattered `Arc::clone`

`Shared<T>` wraps `Arc<T>` and exposes `.share()` — naming the shared-ownership bump
explicitly, which reads better than `Arc::clone(&x)` everywhere and keeps
`clippy::clone_on_ref_ptr` satisfied. (See
<https://users.rust-lang.org/t/about-retained-ownership-and-clone-vs-ar-r-c-clone/65459/5>.)

### Per-chain crates, shared core

The core is fully chain-agnostic. EVM and TRON each provide their request enum, domain
types, embedded UI, read-only queries, and a typed signer over `Engine`. Adding a chain
means a new crate, not changes to core.

### EVM read side: `alloy`

Read-only balance queries (`get_balance`, ERC-20 `get_token_balance`) use `alloy` — the
current standard Rust EVM library — via an HTTP provider and a `sol!` `IERC20` interface.
Signing/sending happens in the browser wallet, so the Rust side needs no signer.

### TRON read side: lean `bs58` + `reqwest`, not a full SDK

The TRON Rust SDKs (`tronic`, `anychain-tron`, …) are gRPC/transaction-building/signing
libraries — they'd add large dependency trees (tonic/prost, k256, ethabi, protobuf) for
features we never call, because **TRON signing and tx-building happen browser-side in
TronLink**. The Rust side only needs (1) Base58Check address handling and (2) two read-only
TronGrid HTTP calls. So we use the maintained `bs58` crate (with checksum) for the address
codec and `reqwest` for the reads. `TronAddress` is stored as its canonical 21 bytes
(`0x41` + 20-byte body) and validated via Base58Check on construction.

### CLI: one-shot, runner structs, clean output streams

Each invocation is one-shot (spin up bridge → act → exit). Dispatch lives in `EvmCli` /
`TronCli` runner structs that own the signer **and** the presentation context, so each
subcommand is a method rather than a function threading `(&signer, &ctx)`. Presentation
(stdout text or `--json`) stays in the binary; the library signers are presentation-free.
Progress/prompts go to **stderr**, results to **stdout**, so `--json` output is cleanly
parseable.

## Embedded UI

`web/evm.html` and `web/tron.html` are self-contained vanilla-JS pages (EIP-6963 / injected
provider discovery for EVM, TronLink for TRON; no build step, no external requests). They're
embedded into the binary with `include_str!` and ported near-verbatim from the reference so
the wire contract stays in sync. This is the one part that must remain JavaScript — it runs
in the wallet's page context.

## Tooling

CI (`.github/workflows/ci.yml`) runs fmt + taplo + `clippy -D warnings` + build + test on an
Arch container (toolchain pinned by `rust-toolchain.toml`), plus a `cargo-llvm-cov → Codecov`
job. A `prek` pre-commit hook mirrors the lint gate locally. The lint set
(`[workspace.lints]`) is clippy `all + pedantic + nursery + cargo` plus targeted restriction
picks and several rust lints, with documented `allow`s for the few that are pure noise on a
pre-publish, multi-dependency workspace.

## Roadmap

- **Phase 4 — daemon + local JSON API.** `daemon start|stop|status`, a discovery file
  (`{port, pid, token}`) with bearer-token auth, a control API (`POST /api/v1/…`), a request
  queue serializing signing for human approval, a session cache (connected address persists
  → skip reconnect), and SSE to a persistent connected tab.
- **Phase 5 — TypeScript adaptors.** A viem `CustomTransport` + hybrid account and an ethers
  `Signer`/`Provider`, both clients of the daemon API.
- **Phase 6 — tests & docs.** Integration tests and a Playwright mock-wallet e2e against the
  Rust bridge (✅ EVM + TRON, in [`tests/e2e-browser`](tests/e2e-browser)), plus expanded docs.
  The e2e suite drives the real bridge through feature-gated harness binaries (`evm-harness`,
  `tron-harness`, sharing generic plumbing) that mount test-only routes via the `start_with`
  extension point above — the same hook the daemon reuses.
