---
status: blocked
tags: [go, release]
---
# Go binding: auto-install the signer binary

## Goal
Go users currently build from source, set `BROWSER_WEB3_SIGNER_BIN`, or download a release
binary. Blocked on demand: build when warranted.

## Decisions
- The options and the recommendation are in ADR 0010
  (`docs/adr/0010-go-binary-auto-install.md`, proposed).
