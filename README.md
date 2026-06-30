# browser-web3-signer

Sign EVM and TRON transactions and messages from the command line **using your own
browser wallet** (MetaMask, Rabby, TronLink, …). A command opens a local page in your
browser, you approve in your wallet, and the result is printed. **The private key never
leaves the browser** — this tool only routes the request and reads the result back.

It's a Rust reimplementation of the browser-signing capability of `mcp-wallet-signer`,
with a CLI as the interface for agents (no MCP). The core is a library so it can be
embedded from other languages; TypeScript adaptors (viem/ethers) over a managed Rust bridge
subprocess are planned (see [Status](#status)).

## How it works

```
  CLI command ──► local HTTP bridge (127.0.0.1) ──► opens browser tab
                        ▲                                   │
                        │  POST /api/complete/:id           ▼
                  result (addr / tx hash / sig) ◄──── you approve in your wallet
```

Each command starts a tiny localhost-only HTTP server, opens the browser to an approval
page, blocks until you act in your wallet (or a 5-minute timeout), prints the result, and
exits. Nothing binds a public interface; the bridge is `127.0.0.1` only.

## Install

Requires a Rust toolchain (pinned to 1.95 via `rust-toolchain.toml`).

```sh
cargo build --release
# binary at target/release/browser-web3-signer
```

## Usage

```sh
browser-web3-signer <evm|tron> <command> [flags]
```

Global flags (any command): `--browser <name>` (open a specific browser instead of the
default), `--print` (print the approval URL but don't open a browser), `--json` (machine-
readable JSON on stdout; human text otherwise). Progress/prompts go to stderr, results to
stdout.

### EVM

```sh
browser-web3-signer evm connect --chain 1
browser-web3-signer evm send-transaction --to 0x… --value 1000000000000000 --chain 1
browser-web3-signer evm sign-message --message "hello"
browser-web3-signer evm sign-typed-data --file ./typed-data.json    # {domain,types,primaryType,message}
```

Built-in chains: Ethereum (1), Sepolia (11155111), Polygon (137), Arbitrum (42161),
Optimism (10), Base (8453), Avalanche (43114), BNB Smart Chain (56). `--value` and the
fee flags are in wei.

### TRON

```sh
browser-web3-signer tron connect
browser-web3-signer tron send-transaction --to T… --amount 1000000          # SUN (1 TRX = 1e6 SUN)
browser-web3-signer tron trigger-contract --contract T… --selector 'transfer(address,uint256)' \
    --params '[{"type":"address","value":"T…"},{"type":"uint256","value":"1"}]'
browser-web3-signer tron sign-message --message "hello"
browser-web3-signer tron deploy-contract --abi-file ./abi.json --bytecode 0x…
```

Networks: `mainnet`, `shasta`, `nile`. Signing and transaction building happen browser-side
in TronLink's `tronWeb`; the Rust side only routes requests.

### Serve (control API for language bindings)

```sh
browser-web3-signer serve --chain evm     # prints the bound port, then blocks
```

Runs the bridge on a stable port for the process lifetime and exposes `POST /api/v1/request`
(body is a request `{type, …}`; opens the wallet, blocks, returns `{success, result}` or
`{success:false, error, code?}`) and `GET /api/v1/health`. A language binding spawns this and
drives the wallet over HTTP — see the [TypeScript binding](ts). Honors the global `--browser` /
`--print` flags for how the approval page opens.

## Configuration (env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_WEB3_EVM_PORT` | `3847` | Preferred bridge port for EVM |
| `BROWSER_WEB3_EVM_CHAIN` | `1` | Default EVM chain id |
| `BROWSER_WEB3_TRON_PORT` | `3848` | Preferred bridge port for TRON |
| `BROWSER_WEB3_TRON_NETWORK` | `mainnet` | Default TRON network |
| `BROWSER` | — | Browser binary to open (else OS default) |

The port is *preferred*, not mandatory: if it's already in use (a concurrent command, or a
daemon), the command falls back to an OS-assigned ephemeral port instead of failing.

## Development

```sh
just            # list recipes
just ci         # fmt + taplo + clippy + build + test (what CI runs)
just test
just lint       # clippy -D warnings
just coverage   # cargo-llvm-cov summary
```

`cargo`/`taplo`/`clippy` are pinned and gated by CI and a `prek` pre-commit hook
(`.pre-commit-config.yaml`). See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and the
rationale behind the key decisions.

### Manual real-wallet test (local anvil)

[`scripts/manual-test-evm.sh`](scripts/manual-test-evm.sh) drives your **real** browser wallet
against a throwaway local [anvil](https://book.getfoundry.sh/anvil/) chain: it starts anvil, has
you connect (adding the local network via `--rpc-url`), funds your address with a cheat code, then
walks through sign-message, sign-typed-data, send-transaction, and an ERC-20 transfer — verifying
each result on-chain with `cast`. You only approve each step in the wallet; no testnet, no faucet,
no real funds. Requires foundry (`anvil`/`cast`/`forge`) + `jq` and a `cargo build`.

## Status

Working today: the one-shot CLI for **EVM and TRON** (connect, send/trigger/deploy,
message + typed-data signing), with an embedded approval UI per chain.

**E2E browser tests**: a Playwright suite drives a mock wallet against the real Rust bridge for
**both EVM and TRON** (connect, sign, send/trigger/deploy, reject, cancel, address mismatch),
testing the full browser interaction flow. Run with `just e2e-setup && just e2e` (one-time
`npm install` + Chromium download, then `just e2e`).

**Control API** (`serve`): `browser-web3-signer serve --chain evm|tron` runs the bridge on a
stable port for its lifetime and exposes `POST /api/v1/request` + `GET /api/v1/health`, printing
the bound port to stdout. This is the long-lived mode language bindings spawn and drive.

**TypeScript binding** ([`ts/`](ts)): a `WalletSignerClient` that spawns and supervises the
`serve` subprocess and drives it over `/api/v1`, plus a **viem** transport + hybrid account — so a
TS program signs with the user's browser wallet, and the persistent tab skips the reconnect prompt
across calls.

Persistent sessions in Rust: hold a single `EvmSigner` / `TronSigner` and reuse it — same stable
port, same effect (the pattern the reference's long-lived `WalletSigner` uses; no daemon required).

Deferred: a full multi-client daemon (discovery file, auth, request queue, SSE), warranted only if
several independent processes must share one connected tab. See
[ARCHITECTURE.md](ARCHITECTURE.md#roadmap).

## License

MIT — see [LICENSE](LICENSE).
