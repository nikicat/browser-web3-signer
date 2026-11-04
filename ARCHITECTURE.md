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
  adaptors. [ADR 0002](docs/adr/0002-no-daemon-managed-serve-subprocess.md) records why this, and not a daemon.

The defining property is preserved: **the private key never leaves the user's browser
wallet.** This process only ferries a request to a local page and reads the signed result
back. The HTTP bridge binds `127.0.0.1` exclusively.

## Workspace layout

```
crates/
  browser-web3-signer-core/   chain-agnostic engine (lib); web/app-core.{js,css} shared UI core
  browser-web3-signer-evm/    EVM requests, domain types, embedded UI in web/evm.html (lib)
  browser-web3-signer-tron/   TRON requests, domain types, embedded UI in web/tron.html (lib)
  browser-web3-signer-btc/    Bitcoin requests, domain types, embedded UI in web/btc.html (lib)
  browser-web3-signer/        the `browser-web3-signer` binary (one-shot CLI)
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
[ADR 0002](docs/adr/0002-no-daemon-managed-serve-subprocess.md)), and the e2e test harness mounts `/api/test/*`, both rather than forking the
router. The merged routes carry their own state and middleware; the core CORS layer applies only
to the core routes.

A request's approval page (`/connect` vs `/sign`) is reported by the request itself via
`Request::url_kind`, and a request is reconstructed from its wire JSON via `Request::from_json`
(the inverse of its `Serialize`). Both live on the core trait, so `Engine::prepare`/`submit`, the
`serve` control API, and the e2e harness all stay chain-agnostic — there is one source of truth
for the discriminator and the wire shape, shared across EVM and TRON.

When the chain's `BROWSER_WEB3_{EVM,TRON,BTC}_ACCOUNT` is set, `serve` binds every request to that
account, read once at startup. The core trait `ExpectedAccount` owns the rule, and each chain
implements it. `from_json` does not read the account variable, so the e2e harness is unaffected.

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

A port is a `Port` (`NonZeroU16`), and "use an ephemeral port" is `BindPort::Ephemeral`, not the
magic value `0`. The configured port is preferred, not mandatory: when it is taken, the bridge
falls back to an ephemeral port ([ADR 0007](docs/adr/0007-preferred-port-with-fallback.md)).

### `Shared<T>` instead of scattered `Arc::clone`

`Shared<T>` wraps `Arc<T>` and exposes `.share()` — naming the shared-ownership bump
explicitly, which reads better than `Arc::clone(&x)` everywhere and keeps
`clippy::clone_on_ref_ptr` satisfied. (See
<https://users.rust-lang.org/t/about-retained-ownership-and-clone-vs-ar-r-c-clone/65459/5>.)

### Per-chain crates, shared core

The core is fully chain-agnostic. EVM, TRON and Bitcoin each provide their request enum, domain
types, embedded UI, and a typed signer over `Engine`. Adding a chain means a new crate, not
changes to core. Bitcoin was the first chain added this way; its design (Unisat, PSBTs,
rust-bitcoin domain types, the returned-PSBT txid check) is recorded in
[ADR 0001](docs/adr/0001-bitcoin-support.md). The `FromStr` error type and the request-JSON
field readers every chain's `from_json` uses live in core's `parse` module.

### No read side: reads belong to the caller

The tool only signs. Balance and other RPC reads belong to the caller
([ADR 0008](docs/adr/0008-no-read-side.md)), which keeps the chain crates free of an RPC stack.

### CLI: one-shot, runner structs, clean output streams

Each invocation is one-shot (spin up bridge → act → exit). Dispatch lives in `EvmCli` /
`TronCli` runner structs that own the signer **and** the presentation context, so each
subcommand is a method rather than a function threading `(&signer, &ctx)`. Presentation
(stdout text or `--json`) stays in the binary; the library signers are presentation-free.
Progress/prompts go to **stderr**, results to **stdout**, so `--json` output is cleanly
parseable.

## Embedded UI

`crates/browser-web3-signer-evm/web/evm.html` and `crates/browser-web3-signer-tron/web/tron.html`
are self-contained vanilla-JS pages (EIP-6963 / injected
provider discovery for EVM, TronLink for TRON; no build step, no external requests). They're
embedded into the binary with `include_str!` and ported near-verbatim from the reference so
the wire contract stays in sync. This is the one part that must remain JavaScript — it runs
in the wallet's page context.

### Shared core + thin chain adapters

The bridge protocol, the app state machine and the error contract (show in-page and retry;
propagate only an explicit Reject or Cancel) live once in
[`app-core.js`](crates/browser-web3-signer-core/web/app-core.js), served at `GET /app-core.js`
with its styles at `GET /app-core.css`. Each page is its markup, its brand colour and a thin chain
adapter passed to `WalletSignerCore.init(adapter)`
([ADR 0006](docs/adr/0006-shared-app-core-js.md)).

When the requested signer differs from the wallet's selected account, the core walks the EVM
account-change cascade ([ADR 0005](docs/adr/0005-evm-account-change.md)). TRON omits the adapter hook
and keeps the passive wrong-address view. Moving these files to TypeScript is
[ADR 0009](docs/adr/0009-approval-pages-in-typescript.md) (proposed).

## Tooling

CI (`.github/workflows/ci.yml`) runs five jobs on every push and pull request: the main
`ci` job (fmt + taplo + `clippy -D warnings` + build + test on an Arch container, toolchain
pinned by `rust-toolchain.toml`); an `e2e` job that builds the `evm-harness`/`tron-harness`/`btc-harness`
binaries (`--features e2e`), installs Chromium, and runs the Playwright mock-wallet suite
against the real Rust bridge; a `ts-binding` job that builds the signer binary, then
typechecks and tests the [TypeScript binding](ts) against the real `serve` subprocess; a
`go-binding` job that builds the binary, then runs `gofmt`/`go vet`/`go test` on the
[Go binding](go) against the real `serve` subprocess; and a `cargo-llvm-cov → Codecov`
coverage job. A `prek` pre-commit hook mirrors the lint gate locally. The lint set
(`[workspace.lints]`) is clippy `all + pedantic + nursery + cargo` plus targeted restriction
picks and several rust lints, with documented `allow`s for the few that are pure noise on a
pre-publish, multi-dependency workspace.

## Language bindings

Each binding spawns and supervises a `serve --chain <chain>` subprocess and drives it over
`POST /api/v1/request` ([ADR 0002](docs/adr/0002-no-daemon-managed-serve-subprocess.md)).

- *TypeScript* ([`ts/`](ts)): `WalletSignerClient` plus a viem `CustomTransport` and hybrid
  account (`transport.ts`, `viem-account.ts`) ported from the reference. Tested against the real
  subprocess with a fake-wallet stand-in.
- *Go* ([`go/`](go)): `EVMClient`, `TronClient` and `BtcClient`, standard library only
  ([ADR 0004](docs/adr/0004-go-binding-stdlib-only.md)). Every operation takes a `context.Context`,
  coded errors surface as typed values (`WrongWalletAddressError`), and results are domain types
  parsed at the boundary. Tested against the real subprocess with the TypeScript binding's
  fake-wallet stand-in.

## Releases

`just release [major|minor|patch|X.Y.Z]` (`scripts/release.sh`) commits the version bump to main
(or a `release/*` branch for a maintenance release) and pushes it with the `vX.Y.Z` tag. The tag
starts [`release.yml`](.github/workflows/release.yml), which checks the tag against the versions
and the branch, runs CI, publishes GitHub release binaries, npm
([ADR 0003](docs/adr/0003-npm-platform-packages.md)) and crates.io, and pushes the `go/vX.Y.Z` tag that
versions the Go module. Only admins may create `v*` tags, and the publishing jobs run in a
`release` environment that only `v*` tags reach. Versions are lockstep across all of them.

## Decision records

Decisions and the alternatives they rejected are in [`docs/adr/`](docs/adr):

- [0001](docs/adr/0001-bitcoin-support.md) Bitcoin browser-wallet support
- [0002](docs/adr/0002-no-daemon-managed-serve-subprocess.md) No daemon; each binding supervises its own `serve`
- [0003](docs/adr/0003-npm-platform-packages.md) Binaries for npm as per-platform `optionalDependencies`
- [0004](docs/adr/0004-go-binding-stdlib-only.md) The Go binding depends on the standard library only
- [0005](docs/adr/0005-evm-account-change.md) Getting an EVM wallet to switch accounts
- [0006](docs/adr/0006-shared-app-core-js.md) One shared approval-page core, thin adapters, no build step
- [0007](docs/adr/0007-preferred-port-with-fallback.md) Preferred port with ephemeral fallback
- [0008](docs/adr/0008-no-read-side.md) No read side
- [0009](docs/adr/0009-approval-pages-in-typescript.md) Approval pages in TypeScript (proposed)
- [0010](docs/adr/0010-go-binary-auto-install.md) Installing the binary for Go users (proposed)
