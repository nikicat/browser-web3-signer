# browser-web3-signer

Sign EVM and TRON transactions and messages from the command line **using your own
browser wallet** (MetaMask, Rabby, TronLink, …). A command opens a local page in your
browser, you approve in your wallet, and the result is printed. **The private key never
leaves the browser** — this tool only routes the request and reads the result back.

It's a Rust reimplementation of the browser-signing capability of `mcp-wallet-signer`,
with a CLI as the interface for agents (no MCP). The core is a library so it can be
embedded from other languages; TypeScript adaptors (viem/ethers) and an optional
long-running daemon are planned (see [Status](#status)).

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
# Read-only (no browser, no wallet):
browser-web3-signer evm get-balance --address 0xd8dA…6045 --chain 8453
browser-web3-signer evm get-token-balance --token 0x833589…2913 --address 0xd8dA…6045 --chain 8453

# Browser-approved:
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
browser-web3-signer tron get-balance --address T… --network mainnet
browser-web3-signer tron connect
browser-web3-signer tron send-transaction --to T… --amount 1000000          # SUN (1 TRX = 1e6 SUN)
browser-web3-signer tron trigger-contract --contract T… --selector 'transfer(address,uint256)' \
    --params '[{"type":"address","value":"T…"},{"type":"uint256","value":"1"}]'
browser-web3-signer tron sign-message --message "hello"
browser-web3-signer tron deploy-contract --abi-file ./abi.json --bytecode 0x…
```

Networks: `mainnet`, `shasta`, `nile`. Signing and transaction building happen browser-side
in TronLink's `tronWeb`; the Rust side only routes requests and does read-only TronGrid
queries.

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

## Status

Working today: the one-shot CLI for **EVM and TRON** (connect, send/trigger/deploy,
message + typed-data signing, read-only balances), with an embedded approval UI per chain.

**E2E browser tests**: a Playwright suite drives a mock wallet against the real Rust bridge,
testing the full browser interaction flow (connect, sign, reject, address mismatch, timeout).
Run with `just e2e-setup && just e2e` (one-time `npm install`, then `just e2e`).

Planned: an optional **daemon** mode exposing a local JSON API (persistent connected tab,
request queue, session cache) for app/language integration, and **TypeScript adaptors**
(viem transport + ethers signer) over that API. See [ARCHITECTURE.md](ARCHITECTURE.md#roadmap).

## License

MIT — see [LICENSE](LICENSE).
