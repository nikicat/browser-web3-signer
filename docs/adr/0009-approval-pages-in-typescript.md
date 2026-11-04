# ADR 0009: Author the approval pages in TypeScript

- **Status:** proposed
- **Date:** 2026-11-04

## Context

The approval-page core and the per-chain adapters are hand-written JavaScript
([ADR 0006](0006-shared-app-core-js.md)). They hold the most intricate client logic in the
project (the account-change flow of [ADR 0005](0005-evm-account-change.md), single-resume
guards, the error contract), with no type checking and no linter. The binary embeds them with
`include_str!`, and the main CI build has no Node toolchain.

## Options

1. **Keep JavaScript, add JSDoc types checked by `tsc --checkJs`.** No build step and no change
   to embedding. Type checking runs in a CI job that already has Node (the `ts-binding` job).
2. **TypeScript compiled in a build step, emitted JS committed.** Real TypeScript; the Rust build
   stays toolchain-free. A CI check must fail when the committed JS is stale.
3. **TypeScript compiled by `build.rs`.** No committed output, but every Rust build, crates.io
   included, needs a TypeScript compiler.
4. **TypeScript transpiled at serve time through an embedded Deno runtime.** No build step, but
   the binary carries a JavaScript runtime for a few hundred lines of code.

## Recommendation

Option 1 first: most of the safety for none of the build cost. Move to option 2 if JSDoc types
prove too clumsy. Options 3 and 4 put a heavy toolchain or runtime on every user.

Task T0004 tracks the work. Linting the same code is task T0010.
