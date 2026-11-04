# ADR 0002: No daemon; each binding supervises its own `serve` subprocess

- **Status:** accepted
- **Date:** 2026-06-30

## Context

A wallet skips its reconnect prompt when the approval page's origin (`127.0.0.1:<port>`) stays
the same across requests. So a caller that signs repeatedly wants a persistent session: one
bridge on one port, one browser tab, reused.

The original `mcp-wallet-signer` (TypeScript) has no daemon, no discovery file, no bearer auth,
no `/api/v1` and no SSE. Its `WalletSigner` is a long-lived in-process object that owns its HTTP
server and binds a stable port. The MCP server builds one at startup and reuses it for every
tool call, and the viem layer (`transport.ts`, `viem-account.ts`) is a thin client of that same
object.

In this port the bridge is Rust, so a TypeScript or Go program cannot hold it in-process.

## Decision

- A Rust program gets persistent sessions by holding an `EvmSigner` / `TronSigner` /
  `BtcSigner` and reusing it. Each owns an `Engine`, binds `BindPort::Preferred` and starts the
  bridge lazily.
- A binding spawns and supervises a `serve --chain <chain>` subprocess for its own lifetime. That
  process runs the bridge on the preferred port, exposes `POST /api/v1/request` and
  `GET /api/v1/health`, prints its bound port on stdout, and blocks until it is killed. The
  binding learns the port from that stdout line, the same way the e2e harnesses do.

This is the reference's `WalletSigner` lifecycle across a process boundary that the binding
owns. A localhost child that the caller spawned needs no discovery file and no auth.

## Alternatives considered

- **A multi-client daemon:** `daemon start|stop|status`, a discovery file (`{port, pid, token}`),
  bearer-token auth, a control API, a request queue serializing human approval, a session cache,
  and SSE to a persistent tab. It is justified only by a need that the reference never had and
  the subprocess model does not meet: several independent processes sharing one connected
  wallet tab. Until someone has that need, it is over-engineering. If it is built, it mounts on
  the `start_with` / `build_router_with` extension point. Task T0005 tracks it.

## Consequences

- Each binding process has its own bridge and tab. Two programs signing at once use two ports
  (see [ADR 0007](0007-preferred-port-with-fallback.md)).
- Shipping a binding means shipping the binary
  ([ADR 0003](0003-npm-platform-packages.md), [ADR 0010](0010-go-binary-auto-install.md)).
