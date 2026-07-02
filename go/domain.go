package signer

import (
	"encoding/hex"
	"fmt"
	"strings"
)

// Domain types for wallet-returned values, mirroring the Rust chain layer (`domain.rs` /
// core `bytes.rs`): the transport returns a raw string, and the typed client parses it
// into the right domain type immediately, so a value that "is an address" cannot be
// confused with one that "is a tx hash". Values are stored as raw bytes (not validated
// strings); parsing accepts hex with or without a `0x` prefix and fails on malformed
// input at the boundary.

// Address is a 20-byte EVM address. Parse one with [ParseAddress]; the zero value is the
// zero address. String renders lowercase `0x…` (EVM tooling compares addresses
// case-insensitively).
type Address [20]byte

// ParseAddress parses a 20-byte EVM address from hex (a `0x` prefix is optional; the
// EIP-55 checksum is not enforced).
func ParseAddress(s string) (Address, error) {
	b, err := decodeHex(s, "address")
	if err != nil {
		return Address{}, err
	}
	if len(b) != len(Address{}) {
		return Address{}, fmt.Errorf("invalid address %q: expected %d bytes, got %d", s, len(Address{}), len(b))
	}
	var a Address
	copy(a[:], b)
	return a, nil
}

// Bytes returns the raw 20 bytes.
func (a Address) Bytes() []byte { return a[:] }

// String returns lowercase hex with a `0x` prefix.
func (a Address) String() string { return "0x" + hex.EncodeToString(a[:]) }

// TxHash is a 32-byte transaction hash (a.k.a. tx id). Parse one with [ParseTxHash].
type TxHash [32]byte

// ParseTxHash parses a 32-byte transaction hash from hex (a `0x` prefix is optional).
func ParseTxHash(s string) (TxHash, error) {
	b, err := decodeHex(s, "tx hash")
	if err != nil {
		return TxHash{}, err
	}
	if len(b) != len(TxHash{}) {
		return TxHash{}, fmt.Errorf("invalid tx hash %q: expected %d bytes, got %d", s, len(TxHash{}), len(b))
	}
	var h TxHash
	copy(h[:], b)
	return h, nil
}

// Bytes returns the raw 32 bytes.
func (h TxHash) Bytes() []byte { return h[:] }

// Hex returns lowercase hex without a `0x` prefix (TRON / tronscan convention).
func (h TxHash) Hex() string { return hex.EncodeToString(h[:]) }

// String returns lowercase hex with a `0x` prefix (EVM / etherscan convention).
func (h TxHash) String() string { return "0x" + h.Hex() }

// Signature is an ECDSA signature (typically 65 bytes, but stored as variable-length
// bytes to tolerate wallet variance; never empty). Parse one with [ParseSignature].
type Signature []byte

// ParseSignature parses a non-empty signature from hex (a `0x` prefix is optional).
func ParseSignature(s string) (Signature, error) {
	b, err := decodeHex(s, "signature")
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, fmt.Errorf("invalid signature %q: empty", s)
	}
	return Signature(b), nil
}

// Bytes returns the raw signature bytes.
func (s Signature) Bytes() []byte { return s }

// String returns lowercase hex with a `0x` prefix.
func (s Signature) String() string { return "0x" + hex.EncodeToString(s) }

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
