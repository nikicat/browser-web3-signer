# browser-web3-signer — Go binding

A thin Go client over the Rust `serve` control API. It lets a Go program sign **EVM and TRON**
transactions and messages with the user's own browser wallet (MetaMask, Rabby, TronLink, …) — the
private key never leaves the browser. Its only dependency is go-ethereum's `common`/`hexutil`
packages, so results plug directly into go-ethereum code.

## How it works

```
your Go program
  │  signer.NewEVMClient(...)   /   signer.NewTronClient(...)
  ▼
ServeProcess ── spawn ──►  browser-web3-signer serve --chain <evm|tron>   (Rust)
  │  ◄── reads bound port      owns the bridge + persistent browser tab
  │  POST /api/v1/request ────► opens the wallet, you approve, result returned
  ▼
your program gets the address / tx hash / signature
```

The client **spawns and supervises the Rust `serve` subprocess** for its lifetime (the
cross-language analog of the reference's in-process server). The subprocess holds the bridge on a
stable port, so the wallet skips the reconnect prompt across calls. Construct one client and reuse
it.

This requires the `browser-web3-signer` binary to be available; the client resolves it
from `ClientOptions.BinPath`, then the `BROWSER_WEB3_SIGNER_BIN` env var, then a workspace
`target/{release,debug}` build (only when running from the repo checkout), then `browser-web3-signer`
on `PATH`. Prebuilt binaries for linux/macOS/windows are on the
[GitHub releases page](https://github.com/nikicat/browser-web3-signer/releases) — download one and
point `BROWSER_WEB3_SIGNER_BIN` at it (or put it on `PATH`); automatic download is planned but not
implemented yet. Building from source (`cargo build`) works as always.

## Usage

```go
import (
	"context"

	signer "github.com/nikicat/browser-web3-signer/go"
)

func main() {
	ctx := context.Background()

	// EVM:
	evm := signer.NewEVMClient(signer.ClientOptions{DefaultChainID: 1})
	defer evm.Shutdown()

	addr, err := evm.Connect(ctx, signer.EVMConnectParams{})
	hash, err := evm.SendTransaction(ctx, signer.EVMSendTxParams{To: "0x…", Value: "1000000000000000"})
	sig, err := evm.SignMessage(ctx, signer.EVMSignMessageParams{Message: "hello"})

	// TRON:
	tron := signer.NewTronClient(signer.ClientOptions{})
	defer tron.Shutdown()

	taddr, err := tron.Connect(ctx, signer.TronConnectParams{Network: "mainnet"})
	txid, err := tron.SendTransaction(ctx, signer.TronSendTxParams{To: "T…", Amount: "1500000"}) // SUN
	_ = err
}
```

`Connect`/`SendTransaction`/`Sign…` block until you approve (or reject) in the browser wallet, and
respect the passed `context.Context` (cancel/deadline). A rejection surfaces as a `*RequestError`;
a connected-address mismatch as a `*WrongWalletAddressError` (match with `errors.As`).

Numeric amounts and fees are decimal strings (EVM wei, TRON SUN); EVM chain ids are integers.
Results are domain types — `Connect` returns a go-ethereum `common.Address` (or a `TronAddress`),
`SendTransaction` and `TriggerContract` a `common.Hash`, `DeployContract` a `TronDeployResult`
(tx hash + deployed contract address), and the sign methods a `hexutil.Bytes` signature — parsed
and validated as they cross back from the wallet. See the [package docs](.) for the full API.

## Development

```sh
go vet ./...
gofmt -l .        # no output = formatted
go test ./...     # integration tests against the real Rust subprocess (build the binary first)
```

The tests drive the real `serve` process but reuse the TypeScript binding's
[`fake-wallet.mjs`](../ts/test/fake-wallet.mjs) as a browser stand-in (via the `Browser` option),
so they exercise the whole stack — spawn, port discovery, request, result — for every EVM and TRON
operation without a real wallet. They **fail** (never silently skip) if a prerequisite is missing:
the `browser-web3-signer` binary must be built (`cargo build` first) and `node` (used by the fake
wallet) must be on `PATH`. CI runs `gofmt`/`go vet`/`go test` as a dedicated `go-binding` job on
every push and PR.
