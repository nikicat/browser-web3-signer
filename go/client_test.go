package signer

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
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

var hexRe = regexp.MustCompile(`^0x[0-9a-fA-F]+$`)

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
	if binPath == "" {
		t.Fatal("browser-web3-signer binary not built; run `cargo build` first")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Fatal("node not found on PATH; the fake wallet needs it")
	}
	fakeWallet = filepath.Join(root, "ts/test/fake-wallet.mjs")
	if !fileExists(fakeWallet) {
		t.Fatalf("fake wallet not found at %s", fakeWallet)
	}
	return binPath, fakeWallet
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func assertHex(t *testing.T, label, got string) {
	t.Helper()
	if !hexRe.MatchString(got) {
		t.Fatalf("%s: expected 0x-hex, got %q", label, got)
	}
}

func TestEVMClient(t *testing.T) {
	binPath, fakeWallet := testEnv(t)
	client := NewEVMClient(ClientOptions{BinPath: binPath, Browser: fakeWallet, DefaultChainID: 1})
	t.Cleanup(func() { _ = client.Shutdown() })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}

	t.Run("Connect", func(t *testing.T) {
		addr, err := client.Connect(ctx, EVMConnectParams{ChainID: 1})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.EqualFold(addr, fakeAddress) {
			t.Fatalf("expected %s, got %s", fakeAddress, addr)
		}
	})

	t.Run("SendTransaction", func(t *testing.T) {
		hash, err := client.SendTransaction(ctx, EVMSendTxParams{
			To:    "0x52908400098527886E0F7030069857D2E4169EE7",
			Value: "1000",
		})
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "tx hash", hash)
	})

	t.Run("SignMessage", func(t *testing.T) {
		sig, err := client.SignMessage(ctx, EVMSignMessageParams{Message: "hello"})
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "signature", sig)
	})

	t.Run("SignTypedData", func(t *testing.T) {
		sig, err := client.SignTypedData(ctx, EVMSignTypedDataParams{
			Domain:      map[string]any{"name": "Test", "version": "1", "chainId": 1},
			Types:       map[string]any{"Message": []any{map[string]any{"name": "content", "type": "string"}}},
			PrimaryType: "Message",
			Message:     map[string]any{"content": "hello"},
		})
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "signature", sig)
	})
}

func TestTronClient(t *testing.T) {
	binPath, fakeWallet := testEnv(t)
	client := NewTronClient(ClientOptions{BinPath: binPath, Browser: fakeWallet})
	t.Cleanup(func() { _ = client.Shutdown() })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}

	const contract = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"

	t.Run("Connect", func(t *testing.T) {
		// The fake wallet returns a canned address for `connect` regardless of chain.
		addr, err := client.Connect(ctx, TronConnectParams{Network: "mainnet"})
		if err != nil {
			t.Fatal(err)
		}
		if addr == "" {
			t.Fatal("expected a non-empty address")
		}
	})

	t.Run("SendTransaction", func(t *testing.T) {
		hash, err := client.SendTransaction(ctx, TronSendTxParams{
			To:     contract,
			Amount: "1500000",
		})
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "tx hash", hash)
	})

	t.Run("TriggerContract", func(t *testing.T) {
		hash, err := client.TriggerContract(ctx, TronTriggerContractParams{
			ContractAddress:  contract,
			FunctionSelector: "transfer(address,uint256)",
			Parameters:       []TronParam{{Type: "address", Value: contract}, {Type: "uint256", Value: "1"}},
			FeeLimit:         "150000000",
		})
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "tx hash", hash)
	})

	t.Run("DeployContract", func(t *testing.T) {
		sig, err := client.DeployContract(ctx, TronDeployContractParams{
			ABI:      []byte(`[{"type":"constructor","inputs":[]}]`),
			Bytecode: "0x6080",
			FeeLimit: "1500000000",
		})
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "result", sig)
	})

	t.Run("SignMessage", func(t *testing.T) {
		sig, err := client.SignMessage(ctx, TronSignMessageParams{Message: "hello"})
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "signature", sig)
	})

	t.Run("SignTypedData", func(t *testing.T) {
		sig, err := client.SignTypedData(ctx, TronSignTypedDataParams{
			Domain:      map[string]any{"name": "Test"},
			Types:       map[string]any{"Message": []any{map[string]any{"name": "content", "type": "string"}}},
			PrimaryType: "Message",
			Message:     map[string]any{"content": "hello"},
		})
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "signature", sig)
	})
}
