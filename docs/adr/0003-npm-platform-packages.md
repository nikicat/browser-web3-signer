# ADR 0003: Ship the binary to npm users as per-platform `optionalDependencies`

- **Status:** accepted
- **Date:** 2026-07-02

## Context

The TypeScript binding spawns the Rust `serve` binary ([ADR 0002](0002-no-daemon-managed-serve-subprocess.md)),
so `npm install browser-web3-signer` has to put a working binary for the user's platform on disk.

## Decision

Tagging `vX.Y.Z` builds the binary for five native targets (static musl on Linux) and publishes
five `@nikicat/browser-web3-signer-<platform>` packages, each carrying one binary. They are
injected into the main `browser-web3-signer` package as exact-pinned `optionalDependencies` at
publish time; npm installs only the one matching the user's OS and CPU. This is the pattern
esbuild and sass-embedded use.

Versions are lockstep: npm package, binary and tag are the same version, and the pipeline
commits nothing. The workflow is `.github/workflows/release.yml`, and `just release` starts it.

## Alternatives considered

- **A postinstall script that downloads the binary:** breaks under `--ignore-scripts`, behind
  registry mirrors and offline, and the download is outside the lockfile's integrity check.
- **A download on first run:** the same problems, moved to the first call, plus a network
  dependency at run time.

Riding npm's own machinery gets lockfile sha512 integrity, registry mirrors, the offline cache
and `--ignore-scripts` immunity for free.

## Consequences

- Six npm packages per release, published together from the protected `release` environment.
- Go has no equivalent mechanism ([ADR 0010](0010-go-binary-auto-install.md)).
