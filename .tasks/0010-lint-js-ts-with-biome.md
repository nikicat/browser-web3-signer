---
status: todo
deps: [T0004]
tags: [tooling, web]
---
# Lint and format the JS/TS code with biome

## Goal
Rust, TOML, Go, shell scripts and the workflows are linted; the JavaScript and TypeScript are not
(the `ts/` binding is only typechecked). Add biome for `ts/`, `tests/e2e-browser/` and the
hand-written approval-page JS (`crates/browser-web3-signer-core/web/app-core.js` and the per-chain
adapters), as a CI step, a `just` recipe and a prek hook. Done = biome runs clean in CI.

## Decisions
- biome over eslint + prettier: one tool, no plugin tree, works on plain JS and TS alike.
- Depends on T0004 only loosely: biome is useful on the JS today, and T0004 would make it a
  TypeScript target.

## Next
Run `npx @biomejs/biome check` on those paths to size the first-run fixes, then pick the rule set.
