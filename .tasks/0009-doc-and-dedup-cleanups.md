---
status: todo
tags: [cleanup]
---
# Doc staleness and small duplication found by unsmell

## Goal
Smells an /unsmell run on the account-gating change found on lines that change did not touch.
Each item below says where, what is wrong, and the fix.

- **"EVM and TRON" is stale** (`crates/browser-web3-signer/src/serve.rs` module doc,
  `ARCHITECTURE.md` "shared across EVM and TRON", `crates/browser-web3-signer-core/src/lib.rs`
  crate doc listing only the evm and tron crates). Bitcoin uses the same generic code
  (`main.rs` instantiates `serve::run` for `BtcRequest`). Fix: say "every chain", or name all three.
- **EVM's default port lives in core** (`DEFAULT_PORT` = 3847 in
  `crates/browser-web3-signer-core/src/config.rs`), while TRON's and Bitcoin's live in their own
  crates. Its doc and `DEFAULT_BTC_PORT`'s doc also restate the other chains' numbers. Fix: move it
  to the evm crate as `DEFAULT_EVM_PORT`, and drop the cross-chain numbers from the docs.
- **`json_field` and `str_opt` are duplicated** in evm and tron `types.rs`; tron's
  `deploy_contract` writes `str_opt` out inline. Fix: move both into `core::parse` beside
  `str_field` and `opt_parsed`.
