---
status: todo
tags: [cleanup]
---
# EVM CLI docs that restate the code

## Goal
An /unsmell run on the `--data-file` change found these docs in
`crates/browser-web3-signer/src/evm.rs`, on lines that change did not touch. Each restates
the code instead of giving the decision behind the item or a fact the signature cannot.

- `EvmCli::approve` narrates its steps (register, surface the URL, open the browser, await,
  parse). Keep only what the caller relies on: it returns the wallet's answer parsed as `T`, and
  how it errors.
- The `EvmCli` doc explains the crate split in a parenthetical. Cite where that split is
  decided (ARCHITECTURE.md), or drop it.
- `EvmCli::sign` names its callers ("Shared tail for `sign_message` / `sign_typed_data`").
- `run` restates the dispatch ("by dispatching to the matching method").

The same docs in `tron.rs` and `btc.rs` likely have the same shape; check them in the same pass.
