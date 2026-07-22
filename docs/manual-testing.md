# Manual real-wallet tests

The Playwright E2E suite covers the full browser flow against a mock wallet; these
scripts cover the last mile — your **real** wallet extension talking to the real bridge,
verified on-chain, against a throwaway local node. No testnet, no faucet, no real funds:
you only approve each step in the wallet.

## EVM (local anvil)

[`scripts/manual-test-evm.sh`](../scripts/manual-test-evm.sh) drives your real browser wallet
against a throwaway local [anvil](https://book.getfoundry.sh/anvil/) chain: it starts anvil, has
you connect (adding the local network via `--rpc-url`), funds your address with a cheat code, then
walks through sign-message, sign-typed-data, send-transaction, and an ERC-20 transfer — verifying
each result on-chain with `cast`. Requires foundry (`anvil`/`cast`/`forge`) + `jq` and a
`cargo build`.

## TRON (local tronbox/tre node)

[`scripts/manual-test-tron.sh`](../scripts/manual-test-tron.sh) is the TronLink counterpart, driven by
a throwaway local [`tronbox/tre`](https://hub.docker.com/r/tronbox/tre) node in Docker. TRON has no
`anvil`/`cast`, so a small TronWeb helper ([`scripts/tron/tron-tool.ts`](../scripts/tron/tron-tool.ts),
run directly by node ≥ 22.6) is the funding + verification layer: it funds your address from the
node's genesis key, deploys/mints a demo TRC-20, and verifies signatures and receipts. TronLink
can't be pointed at a node from the CLI, so the one-time setup is to add `http://127.0.0.1:9090` as
a custom node in TronLink and select it; the script prints the exact steps. Same five stages,
same "you only approve in the wallet" flow. Requires Docker, node ≥ 22.6, `forge`, `jq`, `cargo build`.

One TRON-specific wrinkle: TronLink only knows a chainId for its built-in networks and never queries
a custom node's, so **TIP-712 typed-data signing fails on a local node** (`"Current chainId cannot be
null"`) until you inject it once via [`scripts/tron/inject-chainid.js`](../scripts/tron/inject-chainid.js)
(pasted into TronLink's service-worker console — the script's setup step explains it). The other four
stages don't need it. `DEBUG_RPC=1` logs all wallet→node traffic through a proxy for diagnosis.
