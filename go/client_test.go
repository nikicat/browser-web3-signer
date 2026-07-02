package signer

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Integration tests for the Go binding against the real Rust `serve` subprocess.
//
// A fake-wallet script (passed as the "browser") stands in for the browser+wallet: the
// bridge launches it with the approval URL, and it POSTs a canned result to
// /api/complete/:id. This exercises the whole stack — subprocess spawn, port discovery,
// POST /api/v1/request, the browser-open path, and result unwrapping — without a real
// wallet. We reuse ../ts/test/fake-wallet.mjs verbatim (it is language-agnostic).

// Canned results the fake wallet returns (see ../ts/test/fake-wallet.mjs).
const (
	fakeAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
)

const hexPattern = `^0x[0-9a-fA-F]+$`

// repoRoot returns the workspace root (one level up from this source file's dir).
func repoRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Dir(filepath.Dir(file))
}

// testEnv resolves the built binary and the fake wallet. Any missing prerequisite (the
// binary, node, or the fake wallet) is a hard failure — the test never silently skips.
func testEnv(t *testing.T) (binPath, fakeWallet string) {
	t.Helper()
	root := repoRoot()
	for _, rel := range []string{"target/release/browser-web3-signer", "target/debug/browser-web3-signer"} {
		if p := filepath.Join(root, rel); fileExists(p) {
			binPath = p
			break
		}
	}
	require.NotEmpty(t, binPath, "browser-web3-signer binary not built; run `cargo build` first")
	_, err := exec.LookPath("node")
	require.NoError(t, err, "node not found on PATH; the fake wallet needs it")
	fakeWallet = filepath.Join(root, "ts/test/fake-wallet.mjs")
	require.True(t, fileExists(fakeWallet), "fake wallet not found at %s", fakeWallet)
	return binPath, fakeWallet
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func TestEVMClient(t *testing.T) {
	binPath, fakeWallet := testEnv(t)
	client := NewEVMClient(ClientOptions{BinPath: binPath, Browser: fakeWallet, DefaultChainID: 1})
	t.Cleanup(func() { _ = client.Shutdown() })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	require.NoError(t, client.Start(ctx))

	t.Run("Connect", func(t *testing.T) {
		addr, err := client.Connect(ctx, EVMConnectParams{ChainID: 1})
		require.NoError(t, err)
		want, err := ParseAddress(fakeAddress)
		require.NoError(t, err)
		assert.Equal(t, want, addr)
	})

	t.Run("SendTransaction", func(t *testing.T) {
		hash, err := client.SendTransaction(ctx, EVMSendTxParams{
			To:    "0x52908400098527886E0F7030069857D2E4169EE7",
			Value: "1000",
		})
		require.NoError(t, err)
		assert.NotEqual(t, TxHash{}, hash)
		assert.Regexp(t, hexPattern, hash.String())
	})

	t.Run("SignMessage", func(t *testing.T) {
		sig, err := client.SignMessage(ctx, EVMSignMessageParams{Message: "hello"})
		require.NoError(t, err)
		assert.Regexp(t, hexPattern, sig.String())
	})

	t.Run("SignTypedData", func(t *testing.T) {
		sig, err := client.SignTypedData(ctx, EVMSignTypedDataParams{
			Domain:      map[string]any{"name": "Test", "version": "1", "chainId": 1},
			Types:       map[string]any{"Message": []any{map[string]any{"name": "content", "type": "string"}}},
			PrimaryType: "Message",
			Message:     map[string]any{"content": "hello"},
		})
		require.NoError(t, err)
		assert.Regexp(t, hexPattern, sig.String())
	})
}

func TestTronClient(t *testing.T) {
	binPath, fakeWallet := testEnv(t)
	client := NewTronClient(ClientOptions{BinPath: binPath, Browser: fakeWallet})
	t.Cleanup(func() { _ = client.Shutdown() })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	require.NoError(t, client.Start(ctx))

	// The canned TRON address the fake wallet returns for `connect` and deploy results;
	// also reused as a well-formed contract address in request params.
	const contract = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"

	t.Run("Connect", func(t *testing.T) {
		addr, err := client.Connect(ctx, TronConnectParams{Network: "mainnet"})
		require.NoError(t, err)
		want, err := ParseTronAddress(contract)
		require.NoError(t, err)
		assert.Equal(t, want, addr)
	})

	t.Run("SendTransaction", func(t *testing.T) {
		hash, err := client.SendTransaction(ctx, TronSendTxParams{
			To:     contract,
			Amount: "1500000",
		})
		require.NoError(t, err)
		assert.Regexp(t, hexPattern, hash.String())
	})

	t.Run("TriggerContract", func(t *testing.T) {
		hash, err := client.TriggerContract(ctx, TronTriggerContractParams{
			ContractAddress:  contract,
			FunctionSelector: "transfer(address,uint256)",
			Parameters:       []TronParam{{Type: "address", Value: contract}, {Type: "uint256", Value: "1"}},
			FeeLimit:         "150000000",
		})
		require.NoError(t, err)
		assert.Regexp(t, hexPattern, hash.String())
	})

	t.Run("DeployContract", func(t *testing.T) {
		deployed, err := client.DeployContract(ctx, TronDeployContractParams{
			ABI:      []byte(`[{"type":"constructor","inputs":[]}]`),
			Bytecode: "0x6080",
			FeeLimit: "1500000000",
		})
		require.NoError(t, err)
		assert.NotEqual(t, TxHash{}, deployed.TxHash)
		assert.Equal(t, contract, deployed.ContractAddress.String())
	})

	t.Run("SignMessage", func(t *testing.T) {
		sig, err := client.SignMessage(ctx, TronSignMessageParams{Message: "hello"})
		require.NoError(t, err)
		assert.Regexp(t, hexPattern, sig.String())
	})

	t.Run("SignTypedData", func(t *testing.T) {
		sig, err := client.SignTypedData(ctx, TronSignTypedDataParams{
			Domain:      map[string]any{"name": "Test"},
			Types:       map[string]any{"Message": []any{map[string]any{"name": "content", "type": "string"}}},
			PrimaryType: "Message",
			Message:     map[string]any{"content": "hello"},
		})
		require.NoError(t, err)
		assert.Regexp(t, hexPattern, sig.String())
	})
}
