# ADR 0008: No read side; RPC reads belong to the caller

- **Status:** accepted
- **Date:** 2026-07-01

## Context

The first version had read-only commands (`get-balance`, `get-token-balance`). A read needs no
wallet, no browser and no key: `cast` or any EVM or TRON SDK does it in one call.

## Decision

The tool is purely a browser-signing bridge. Plain JSON-RPC reads live with the caller, and the
read commands were removed.

## Alternatives considered

- **Keep the reads:** each chain crate would carry an RPC client and HTTP stack for something
  every caller already has.

## Consequences

- The EVM crate uses `alloy` only for its primitive domain types (`Address`, `Wei`/`U256`,
  `Bytes`), not for a provider or RPC stack.
- The TRON crate uses `alloy-primitives` plus `bs58` (with checksum) for the Base58Check address
  codec, and no HTTP client.
