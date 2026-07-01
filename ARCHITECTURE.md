# Architecture

This document describes the design of `browser-web3-signer` and the rationale behind the
decisions that shaped it. It supersedes the original planning notes.

## Goal & context

Reimplement, in Rust, the browser-signing capability of `mcp-wallet-signer` (a Deno/TS
project), with two changes of intent:

- **The CLI is the interface for agents** — MCP is dropped. An agent runs a command and
  reads stdout.
- **The core is a reusable library**, so the capability can be embedded from other
  languages (via bindings that manage a Rust bridge subprocess) and wrapped by TypeScript
  adaptors. See [Roadmap](#roadmap) for why this, and not a daemon, is the planned path.

The defining property is preserved: **the private key never leaves the user's browser
wallet.** This process only ferries a request to a local page and reads the signed result
back. The HTTP bridge binds `127.0.0.1` exclusively.

## Workspace layout

```
crates/
  browser-web3-signer-core/   chain-agnostic engine (lib)
  browser-web3-signer-evm/    EVM requests, domain types, embedded UI (lib)
  browser-web3-signer-tron/   TRON requests, domain types, embedded UI (lib)
  browser-web3-signer/        the `browser-web3-signer` binary (one-shot CLI)
web/
  evm.html / tron.html        self-contained vanilla-JS approval UIs (embedded via include_str!)
ts/                           TypeScript binding (viem transport + hybrid account over `serve`)
go/                           Go binding (stdlib-only client over `serve`)
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

`Engine::submit` is the convenience path (prepare + open + await) for library/binding callers;
the CLI uses `prepare` so it can print the URL before opening. Requests time out after
5 minutes; a timed-out or cancelled entry is removed so the bridge stops serving it.

The HTTP bridge (axum) exposes exactly: `GET /api/pending/:id`, `POST /api/complete/:id`,
`GET /api/health`, and a fallback that serves the embedded SPA for any other path (the
in-page router dispatches `/connect/:id` and `/sign/:id`). CORS mirrors the reference
(`*`, GET/POST/OPTIONS). The request/result JSON shapes and endpoint paths are kept
**byte-compatible with the reference UI**, so the ported HTML works unchanged and future
TS adaptors interoperate.

`build_router_with` / `Engine::start_with` add an **extension point**: a caller can merge its
own routes onto the core bridge, sharing the same `PendingStore`. Two callers use it today: the
`serve` control API mounts `/api/v1/*` (the long-lived mode language bindings drive — see
[Roadmap](#roadmap)), and the e2e test harness mounts `/api/test/*`, both rather than forking the
router. The merged routes carry their own state and middleware; the core CORS layer applies only
to the core routes.

A request's approval page (`/connect` vs `/sign`) is reported by the request itself via
`Request::url_kind`, and a request is reconstructed from its wire JSON via `Request::from_json`
(the inverse of its `Serialize`). Both live on the core trait, so `Engine::prepare`/`submit`, the
`serve` control API, and the e2e harness all stay chain-agnostic — there is one source of truth
for the discriminator and the wire shape, shared across EVM and TRON.

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
- **A long-lived signer** (a reused `EvmSigner`/`TronSigner`, or one held by a binding's managed
  bridge subprocess) keeps the preferred port for its whole lifetime, so the persistent tab's
  origin never changes — the same mechanism, just longer-lived. Only a future multi-client
  daemon (see [Roadmap](#roadmap)) would need a request queue to share one port across processes.

### `Shared<T>` instead of scattered `Arc::clone`

`Shared<T>` wraps `Arc<T>` and exposes `.share()` — naming the shared-ownership bump
explicitly, which reads better than `Arc::clone(&x)` everywhere and keeps
`clippy::clone_on_ref_ptr` satisfied. (See
<https://users.rust-lang.org/t/about-retained-ownership-and-clone-vs-ar-r-c-clone/65459/5>.)

### Per-chain crates, shared core

The core is fully chain-agnostic. EVM and TRON each provide their request enum, domain
types, embedded UI, and a typed signer over `Engine`. Adding a chain means a new crate, not
changes to core.

### No read side: reads belong to the caller

This tool is purely a browser-signing bridge. Plain JSON-RPC reads (native/token balances,
etc.) need no wallet, browser, or key — they're trivially done with `cast` or any EVM/TRON
SDK — so they live with the caller, not here. Dropping them keeps the dependency footprint
small: the EVM crate uses `alloy` only for its primitive domain types (`Address`, `Wei`/`U256`,
`Bytes`), not for a provider/RPC stack, and the TRON crate uses just `alloy-primitives` plus the
maintained `bs58` crate (with checksum) for the Base58Check address codec — no HTTP client. EVM
`Address` and `TronAddress` are validated on construction (the latter stored as its canonical
21 bytes: `0x41` prefix + 20-byte body).

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

### Shared core + thin chain adapters

The logic the two pages used to duplicate — the bridge protocol (`fetchPendingRequest` /
`completeSuccess` / `completeError`), the app state machine + view switching, `rejectWith` /
address-matching, the settled-result delivery, and the **error contract** (show in-page + retry,
propagate only on explicit Reject/Cancel) — lives once in [`web/app-core.js`](web/app-core.js).
The core crate embeds it with `include_str!` and serves it at `GET /app-core.js` from
`build_router` (so every bridge — CLI, `serve`, and the e2e harnesses — exposes it). Both pages
load it via `<script src="/app-core.js">` and call `WalletSignerCore.init(adapter)`.

Each page is now only its markup + styles plus a thin chain **adapter**: the wallet operations
(`connect` via `requestAccounts`/`onConnected`, `sendTx`, `signMessage`, `signTypedData`),
wallet presence/identity, `addressMatch` (case-insensitive for EVM 0x-hex, case-sensitive for
TRON Base58), and the chain-specific slices of presentation (badge text, `renderTxDetails`,
button labels). The core owns the flow; the adapter owns the chain. This is what fixed the
duplicated-bug problem the split was motivated by: the "don't `completeError` on a recoverable
catch" contract and the settled-result / terminal-delivery handling (which had landed in
`evm.html` but not `tron.html`) are now defined once and apply to both chains.

This is the one place a small future build step could help: see the `APP_CORE_JS` TODO in
`crates/browser-web3-signer-core/src/http.rs` for authoring the shared core (and the adapters)
in TypeScript, transpiled either at serve time via a Deno runtime or in a build step, kept as
hand-written JS for now so `include_str!` needs no toolchain in the Node-less CI build.

## Tooling

CI (`.github/workflows/ci.yml`) runs five jobs on every push and pull request: the main
`ci` job (fmt + taplo + `clippy -D warnings` + build + test on an Arch container, toolchain
pinned by `rust-toolchain.toml`); an `e2e` job that builds the `evm-harness`/`tron-harness`
binaries (`--features e2e`), installs Chromium, and runs the Playwright mock-wallet suite
against the real Rust bridge; a `ts-binding` job that builds the signer binary, then
typechecks and tests the [TypeScript binding](ts) against the real `serve` subprocess; a
`go-binding` job that builds the binary, then runs `gofmt`/`go vet`/`go test` on the
[Go binding](go) against the real `serve` subprocess; and a `cargo-llvm-cov → Codecov`
coverage job. A `prek` pre-commit hook mirrors the lint gate locally. The lint set
(`[workspace.lints]`) is clippy `all + pedantic + nursery + cargo` plus targeted restriction
picks and several rust lints, with documented `allow`s for the few that are pure noise on a
pre-publish, multi-dependency workspace.

## Roadmap

### How persistent sessions actually work (and why there is no daemon phase)

The original `mcp-wallet-signer` (TS) has **no daemon** — no discovery file, no bearer auth, no
`/api/v1`, no SSE. We read the reference to check, and the persistent-session problem is solved
differently: its `WalletSigner` is a **long-lived in-process object that owns its HTTP server and
binds a stable port**. You construct it once and reuse it for many operations; because the origin
(`127.0.0.1:<port>`) stays fixed, the wallet skips the reconnect prompt on subsequent calls. The
MCP server does exactly this — one `WalletSigner` at startup, reused across every tool call. The
viem layer (`transport.ts`, `viem-account.ts`) is then a thin client of *that same in-process
object*, not of any network service.

Our `EvmSigner` / `TronSigner` are already this: each owns an `Engine`, binds
`BindPort::Preferred` (the stable port), and lazily starts the bridge on first use. **A Rust
program gets persistent sessions today by holding a signer and reusing it** — no extra machinery.

The one thing the reference never had to solve, but we do: there, the signer *and* its consumers
live in the same Node process, so persistence is just object lifetime. In our port the server is
**Rust**, so a TS/Go consumer can't hold it in-process. The lightweight, faithful analog is for
the binding to **spawn and supervise a Rust bridge subprocess for its own lifetime** — the same
`WalletSigner` lifecycle, across a process boundary the binding owns. One stable port, one
persistent tab, dies with the parent. The port is learned from the child's stdout (the mechanism
the e2e harnesses already use), so this needs **no discovery file and no auth** (it's a localhost
child you spawned).

### Phases

- **Phase 4 — language bindings over a managed bridge subprocess.** ✅ done.
  - *Control API:* `serve --chain evm|tron` runs the bridge on the preferred (stable) port for
    the process lifetime and exposes `POST /api/v1/request` (create → open browser → block →
    return result) + `GET /api/v1/health`, mounted via the `start_with` extension point. It
    prints the bound port to stdout, then blocks. Generic over the chain's request type.
  - *Rust:* `EvmSigner` / `TronSigner` are the reusable, persistent-session API (hold one and
    reuse it).
  - *TypeScript:* [`ts/`](ts) — `WalletSignerClient` spawns and supervises the `serve`
    subprocess and drives it over `/api/v1`, plus a viem `CustomTransport` + hybrid account
    (`transport.ts`, `viem-account.ts`) ported from the reference. Tested against the real
    subprocess with a fake-wallet stand-in.
  - *Go:* [`go/`](go) — `EVMClient` / `TronClient` spawn and supervise the `serve` subprocess and
    drive it over `/api/v1`. A thin, dependency-free (stdlib-only) client covering both chains
    (connect / send / trigger / deploy / message + typed-data signing); every op takes a
    `context.Context` and coded errors surface as typed values (`WrongWalletAddressError`). No
    viem-style layer — Go's go-ethereum signing model fits the wallet's `eth_sendTransaction`
    poorly, so the raw client is the whole surface. Tested against the real subprocess, reusing the
    TS binding's fake-wallet stand-in.
- **Phase 5 — full multi-client daemon (deferred; build only on demand).** A standalone
  `daemon start|stop|status` with a discovery file (`{port, pid, token}`), bearer-token auth, a
  control API (`POST /api/v1/…`), a request queue serializing human approval, a session cache,
  and SSE to a persistent tab. This is only justified by a requirement the reference never had
  and Phase 4 doesn't meet: **several independent processes sharing one connected wallet tab.**
  Absent that, it is over-engineering — the per-binding managed subprocess above already gives a
  single consumer a persistent session. The `start_with` / `build_router_with` extension point
  (above) is the seam this would mount on if built.
- **Phase 6 — tests & docs.** Integration tests and a Playwright mock-wallet e2e against the
  Rust bridge (✅ EVM + TRON, in [`tests/e2e-browser`](tests/e2e-browser)), plus expanded docs.
  The e2e suite drives the real bridge through feature-gated harness binaries (`evm-harness`,
  `tron-harness`, sharing generic plumbing) that mount test-only routes via the `start_with`
  extension point above.
