# browser-web3-signer — Go binding

A thin Go client over the Rust `serve` control API. It lets a Go program sign **EVM, TRON and Bitcoin**
transactions and messages with the user's own browser wallet (MetaMask, Rabby, TronLink, Unisat,
Leather, …) — the
private key never leaves the browser. It uses go-ethereum's `common`/`hexutil` packages for its
EVM types, so results plug directly into the go-ethereum code most consumers already have (the
client is thin by design, but doesn't avoid well-established dependencies on principle).

## How it works

```
your Go program
  │  signer.NewEVMClient(...)  /  signer.NewTronClient(...)  /  signer.NewBtcClient(...)
  ▼
ServeProcess ── spawn ──►  browser-web3-signer serve --chain <evm|tron|btc>   (Rust)
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

```sh
go get github.com/nikicat/browser-web3-signer/go@latest   # versioned via go/vX.Y.Z tags
```

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

	// Bitcoin:
	btc := signer.NewBtcClient(signer.ClientOptions{})
	defer btc.Shutdown()

	account, err := btc.Connect(ctx, signer.BtcConnectParams{Network: "mainnet"}) // address + public key
	btxid, err := btc.SendTransfer(ctx, signer.BtcSendTransferParams{To: "bc1…", Amount: 10000, Network: "mainnet"}) // sats
	signed, err := btc.SignPsbt(ctx, signer.BtcSignPsbtParams{Psbt: psbtBytes, Network: "mainnet"})
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
and validated as they cross back from the wallet.

Bitcoin results are checked by `serve` against the request before they reach Go (the address is on
the request's network, a signed PSBT is for the same transaction, a broadcast txid matches it), so
`BtcClient` only decodes them: `Connect` returns a `BtcAccount` (address and public key), `SendTransfer` a `BtcTxid`,
`SignPsbt` a `BtcSignedPsbt` (PSBT bytes, plus the txid when broadcast) and `SignMessage` the
signature bytes. PSBTs go in and come out as raw bytes, so you can use any PSBT library. See the
[package docs](.) for the full API.

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
