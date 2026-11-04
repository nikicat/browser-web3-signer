# ADR 0007: The bridge prefers a stable port and falls back to an ephemeral one

- **Status:** accepted
- **Date:** 2026-06-30

## Context

A wallet remembers a connected origin. If the approval page's origin (`127.0.0.1:<port>`)
changes between requests, the wallet asks to reconnect every time. But two commands running at
once cannot both bind one port.

## Decision

Each chain has a preferred port (EVM 3847, TRON 3848, Bitcoin 3849), configurable through
`BROWSER_WEB3_{EVM,TRON,BTC}_PORT`. The bridge tries it first, and when it is in use it binds an
OS-assigned ephemeral port instead of failing. A port is a `Port` (`NonZeroU16`); "use an
ephemeral port" is a distinct `BindPort::Ephemeral`, never the magic value `0`.

A long-lived signer, such as a reused `EvmSigner` or a binding's `serve` process, holds the
preferred port for its whole lifetime, so its tab's origin never changes.

## Alternatives considered

- **Always the fixed port:** the second concurrent command fails.
- **Always an ephemeral port:** the wallet asks to reconnect on every command.

## Consequences

- A command that fell back to an ephemeral port gets a reconnect prompt for that run only.
- Sharing one port across processes would need a request queue, which only the deferred daemon
  of [ADR 0002](0002-no-daemon-managed-serve-subprocess.md) would have.
