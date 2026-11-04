# ADR 0010: Install the signer binary for Go users

- **Status:** proposed
- **Date:** 2026-11-04

## Context

The Go binding spawns the `serve` binary ([ADR 0002](0002-no-daemon-managed-serve-subprocess.md)).
npm users get it through platform packages ([ADR 0003](0003-npm-platform-packages.md)), but a Go
module is served verbatim from the git tree, so there is no equivalent. Today Go users build
from source, set `BROWSER_WEB3_SIGNER_BIN`, or download a release binary.

## Options

1. **Commit the binaries into the module.** Works with `go get` alone, but adds five binaries to
   the git tree on every release.
2. **Download at run time, verified against a committed per-release SHA-256 table.** The
   binding fetches the GitHub release asset for its own version on first use and checks it
   against hashes committed with that version, as HashiCorp's hc-install does. This is stronger
   than the unverified downloads of playwright-go and go-rod.
3. **Keep the status quo.**

## Recommendation

Option 2, when there is demand from Go users. Until then, option 3. Task T0006 tracks it.
