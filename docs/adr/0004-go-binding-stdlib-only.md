# ADR 0004: The Go binding depends on the standard library only

- **Status:** accepted
- **Date:** 2026-11-03

## Context

The Go binding (`go/`) first returned go-ethereum's `common.Address`, `common.Hash` and
`hexutil.Bytes`, so its `go.mod` required go-ethereum v1.17.10. Go's minimal version selection
raised every consumer's go-ethereum requirement to that version, which silently disabled a
consumer's version-pinned `replace` of its go-ethereum fork.

## Decision

The binding defines its own domain types: `EVMAddress` (`[20]byte`), `TxHash` (`[32]byte`),
`HexBytes` and `TronAddress` (canonical 21 bytes, Base58Check). It depends on the standard
library alone; testify is used in tests only. `EVMAddress` and `TxHash` share go-ethereum's
underlying types, so a go-ethereum caller converts with `common.Address(a)` / `common.Hash(h)`.

There is no viem-style signing layer: go-ethereum's signing model fits the wallet's
`eth_sendTransaction` poorly, so the raw client is the whole surface.

## Alternatives considered

- **Keep the go-ethereum types:** convenient for go-ethereum callers, but any library
  dependency on go-ethereum imposes its version on every consumer.

## Consequences

- `EVMAddress.String()` renders lowercase hex, not the EIP-55 checksum.
- The change was breaking (`feat(go)!`) for callers that used the go-ethereum types directly.
