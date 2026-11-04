---
status: blocked
tags: [go, release]
---
# Go binding: auto-install the signer binary

## Goal
Go users currently build from source, set `BROWSER_WEB3_SIGNER_BIN`, or download a release
binary. Blocked on demand: build when warranted.

## Decisions
- Runtime download verified against a committed per-release SHA-256 table (hc-install-grade),
  not committed artifacts: a Go module is served verbatim from the git tree.
