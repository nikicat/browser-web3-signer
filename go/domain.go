package signer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

// Domain types for wallet-returned values, mirroring the Rust chain layer (`domain.rs` /
// core `bytes.rs`): the transport returns a raw string, and the typed client parses it
// into the right domain type immediately, so a value that "is an address" cannot be
// confused with one that "is a tx hash". EVM values use go-ethereum's primitives
// ([common.Address], [common.Hash], [hexutil.Bytes]) — the types callers' go-ethereum
// code already speaks; TRON addresses have no go-ethereum equivalent and are defined
// here. Parsing validates at the boundary (go-ethereum's own HexToAddress/HexToHash
// silently pad and truncate malformed input, so they are never used directly on wallet
// results) and accepts hex with or without a `0x` prefix.

// ParseAddress parses and validates a 20-byte EVM address from hex (a `0x` prefix is
// optional; the EIP-55 checksum is not enforced). Note [common.Address.Hex] renders the
// EIP-55 checksummed form.
func ParseAddress(s string) (common.Address, error) {
	if !common.IsHexAddress(s) {
		return common.Address{}, fmt.Errorf("invalid address %q", s)
	}
	return common.HexToAddress(s), nil
}

// ParseTxHash parses and validates a 32-byte transaction hash from hex (a `0x` prefix is
// optional).
func ParseTxHash(s string) (common.Hash, error) {
	b, err := decodeHex(s, "tx hash")
	if err != nil {
		return common.Hash{}, err
	}
	if len(b) != common.HashLength {
		return common.Hash{}, fmt.Errorf("invalid tx hash %q: expected %d bytes, got %d", s, common.HashLength, len(b))
	}
	return common.BytesToHash(b), nil
}

// ParseSignature parses a non-empty ECDSA signature from hex (a `0x` prefix is optional;
// typically 65 bytes, but variable length to tolerate wallet variance).
func ParseSignature(s string) (hexutil.Bytes, error) {
	b, err := decodeHex(s, "signature")
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, fmt.Errorf("invalid signature %q: empty", s)
	}
	return hexutil.Bytes(b), nil
}

// TronAddress is a TRON address stored as its canonical 21 bytes: the `0x41` mainnet
// prefix followed by the 20-byte body. Parse one with [ParseTronAddress] (Base58Check,
// checksum verified); String renders the canonical Base58Check form (`T…`).
type TronAddress [21]byte

// ParseTronAddress parses a Base58Check TRON address, verifying the 4-byte
// double-SHA-256 checksum and the `0x41` prefix.
func ParseTronAddress(s string) (TronAddress, error) {
	payload, err := base58CheckDecode(s)
	if err != nil {
		return TronAddress{}, fmt.Errorf("invalid tron address %q: %w", s, err)
	}
	if len(payload) != len(TronAddress{}) {
		return TronAddress{}, fmt.Errorf("invalid tron address %q: expected %d-byte payload, got %d", s, len(TronAddress{}), len(payload))
	}
	if payload[0] != 0x41 {
		return TronAddress{}, fmt.Errorf("invalid tron address %q: expected 0x41 prefix", s)
	}
	var a TronAddress
	copy(a[:], payload)
	return a, nil
}

// Bytes returns the raw 21 bytes (`0x41` prefix + 20-byte body).
func (a TronAddress) Bytes() []byte { return a[:] }

// Body returns the 20-byte address body (without the `0x41` prefix), for ABI encoding.
func (a TronAddress) Body() []byte { return a[1:] }

// String returns the canonical Base58Check form (`T…`).
func (a TronAddress) String() string { return base58CheckEncode(a[:]) }

// TronDeployResult is the typed result of [TronClient.DeployContract]: the broadcast tx
// hash and the deployed contract's address.
type TronDeployResult struct {
	TxHash          common.Hash
	ContractAddress TronAddress
}

// parseTronDeployResult parses a `deploy_contract` result (JSON `{txHash,
// contractAddress}`) into typed values (the analog of the Rust signer's
// `parse_deploy_result`).
func parseTronDeployResult(raw string) (TronDeployResult, error) {
	var wire struct {
		TxHash          string `json:"txHash"`
		ContractAddress string `json:"contractAddress"`
	}
	if err := json.Unmarshal([]byte(raw), &wire); err != nil {
		return TronDeployResult{}, fmt.Errorf("malformed deploy result %q: %w", raw, err)
	}
	hash, err := ParseTxHash(wire.TxHash)
	if err != nil {
		return TronDeployResult{}, fmt.Errorf("deploy result %q: %w", raw, err)
	}
	addr, err := ParseTronAddress(wire.ContractAddress)
	if err != nil {
		return TronDeployResult{}, fmt.Errorf("deploy result %q: %w", raw, err)
	}
	return TronDeployResult{TxHash: hash, ContractAddress: addr}, nil
}

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

var (
	base58Radix = big.NewInt(58)
	base58Index = func() (idx [256]int8) {
		for i := range idx {
			idx[i] = -1
		}
		for i := range len(base58Alphabet) {
			idx[base58Alphabet[i]] = int8(i)
		}
		return idx
	}()
)

// base58CheckDecode decodes a Base58Check string, verifying and stripping the trailing
// 4-byte double-SHA-256 checksum.
func base58CheckDecode(s string) ([]byte, error) {
	if s == "" {
		return nil, errors.New("empty")
	}
	n := new(big.Int)
	for i := range len(s) {
		d := base58Index[s[i]]
		if d < 0 {
			return nil, fmt.Errorf("invalid base58 character %q", s[i])
		}
		n.Mul(n, base58Radix).Add(n, big.NewInt(int64(d)))
	}
	zeros := 0 // leading '1' digits encode leading zero bytes
	for zeros < len(s) && s[zeros] == '1' {
		zeros++
	}
	payload := append(make([]byte, zeros), n.Bytes()...)
	if len(payload) < 4 {
		return nil, errors.New("too short for a checksum")
	}
	data, check := payload[:len(payload)-4], payload[len(payload)-4:]
	if !bytes.Equal(check, checksum(data)) {
		return nil, errors.New("bad checksum")
	}
	return data, nil
}

// base58CheckEncode encodes data with a trailing 4-byte double-SHA-256 checksum.
func base58CheckEncode(data []byte) string {
	payload := append(append(make([]byte, 0, len(data)+4), data...), checksum(data)...)
	n := new(big.Int).SetBytes(payload)
	mod := new(big.Int)
	var out []byte
	for n.Sign() > 0 {
		n.DivMod(n, base58Radix, mod)
		out = append(out, base58Alphabet[mod.Int64()])
	}
	for _, b := range payload {
		if b != 0 {
			break
		}
		out = append(out, '1')
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

// checksum returns the first 4 bytes of the double SHA-256 of data.
func checksum(data []byte) []byte {
	first := sha256.Sum256(data)
	second := sha256.Sum256(first[:])
	return second[:4]
}

// decodeHex decodes hex with an optional `0x` prefix, labelling errors with `what`.
func decodeHex(s, what string) ([]byte, error) {
	raw, _ := strings.CutPrefix(s, "0x")
	b, err := hex.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid %s %q: %w", what, s, err)
	}
	return b, nil
}

// parseResult parses a wallet-returned string into a domain type, mapping failures to an
// error (the Go analog of the Rust signer's `parse_signed`).
func parseResult[T any](raw string, parse func(string) (T, error)) (T, error) {
	v, err := parse(raw)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("wallet returned %w", err)
	}
	return v, nil
}
