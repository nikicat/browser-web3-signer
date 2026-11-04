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
- The options and the recommendation are in ADR 0009
  (`docs/adr/0009-approval-pages-in-typescript.md`, proposed).

## Next
Accept or amend ADR 0009, then start with its recommended option (JSDoc types checked by
`tsc --checkJs`).
