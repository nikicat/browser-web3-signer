---
status: todo
tags: [web]
---
# Author the approval-page core and adapters in TypeScript

## Goal
`crates/browser-web3-signer-core/web/app-core.js` and the per-chain page adapters are
hand-written JS. Author them in TypeScript for type safety. Done = typed sources, emitted JS
still served via `include_str!`, CI still builds without Node.

## Decisions
- Kept as JS so far because `include_str!` must work in the Node-less CI build.

## Next
Pick one: transpile at serve time with a Deno runtime from the `.ts`, or compile in a build
step and embed the emitted `.js` (committed, or built in CI).
