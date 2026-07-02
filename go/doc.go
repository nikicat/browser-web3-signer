// Package signer is a Go binding for browser-web3-signer: it signs EVM and TRON
// transactions and messages using the user's own browser wallet (MetaMask, Rabby,
// TronLink, …). The private key never leaves the browser — this package only routes a
// request to a local approval page and reads the signed result back.
//
// It is the cross-language analog of the reference's in-process server: an [EVMClient]
// or [TronClient] spawns and supervises a `browser-web3-signer serve` subprocess (the
// Rust process that owns the bridge and the persistent browser tab on a stable port) and
// drives it over the `/api/v1` control API. Construct one client and reuse it; the
// subprocess holds a stable port for its lifetime, so the wallet skips the reconnect
// prompt across calls.
//
// This is a thin, dependency-free (standard-library-only) client. It mirrors the
// TypeScript binding in ../ts, with idiomatic Go additions: every operation takes a
// [context.Context], coded errors surface as typed values matched with [errors.As]
// (see [WrongWalletAddressError]), and results are domain types ([Address],
// [TronAddress], [TxHash], [Signature], [TronDeployResult]) validated as they cross
// back from the wallet.
//
// The `browser-web3-signer` binary must be built (`cargo build`) or on `PATH`; see
// [ServeOptions] for how it is resolved.
//
// Example (EVM):
//
//	c := signer.NewEVMClient(signer.ClientOptions{DefaultChainID: 1})
//	defer c.Shutdown()
//	addr, err := c.Connect(ctx, signer.EVMConnectParams{})
//	hash, err := c.SendTransaction(ctx, signer.EVMSendTxParams{To: "0x…", Value: "1000000000000000"})
//	sig, err := c.SignMessage(ctx, signer.EVMSignMessageParams{Message: "hello"})
package signer
