package signer

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseAddress(t *testing.T) {
	const checksummed = "0x52908400098527886E0F7030069857D2E4169EE7"

	a, err := ParseAddress(checksummed)
	require.NoError(t, err)
	assert.Equal(t, strings.ToLower(checksummed), a.String(), "String() renders lowercase")

	bare, err := ParseAddress(strings.TrimPrefix(checksummed, "0x"))
	require.NoError(t, err)
	assert.Equal(t, a, bare, "prefixed and bare parses agree")

	for _, bad := range []string{"", "0x1234", "0xzz08400098527886E0F7030069857D2E4169EE7"} {
		_, err := ParseAddress(bad)
		assert.Error(t, err, "input %q", bad)
	}
}

func TestParseTxHash(t *testing.T) {
	const hex64 = "abababababababababababababababababababababababababababababababab"

	a, err := ParseTxHash("0x" + hex64)
	require.NoError(t, err)
	b, err := ParseTxHash(hex64)
	require.NoError(t, err)
	assert.Equal(t, a, b, "prefixed and bare parses agree")
	assert.Equal(t, hex64, a.Hex())
	assert.Equal(t, "0x"+hex64, a.String())

	for _, bad := range []string{"", "0x12", "0x" + hex64 + "ab"} {
		_, err := ParseTxHash(bad)
		assert.Error(t, err, "input %q", bad)
	}
}

func TestParseSignature(t *testing.T) {
	s, err := ParseSignature("0xdeadbeef")
	require.NoError(t, err)
	assert.Equal(t, "0xdeadbeef", s.String())
	assert.Equal(t, []byte{0xde, 0xad, 0xbe, 0xef}, s.Bytes())

	for _, bad := range []string{"", "0x", "0xzz"} {
		_, err := ParseSignature(bad)
		assert.Error(t, err, "input %q", bad)
	}
}

func TestParseTronAddress(t *testing.T) {
	// The Tron foundation address (also used in the Rust domain tests).
	const valid = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"

	a, err := ParseTronAddress(valid)
	require.NoError(t, err)
	assert.Equal(t, valid, a.String(), "Base58Check roundtrip")
	assert.Equal(t, byte(0x41), a.Bytes()[0])
	assert.Len(t, a.Body(), 20)

	for _, bad := range []string{
		"", "0xabc",
		"TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeD", // corrupted checksum
		"TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDe0", // '0' is not a base58 character
		"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // valid Base58Check, but a 0x00 (Bitcoin) prefix
	} {
		_, err := ParseTronAddress(bad)
		assert.Error(t, err, "input %q", bad)
	}
}

func TestParseTronDeployResult(t *testing.T) {
	const addr = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"
	raw := `{"txHash":"` + strings.Repeat("ab", 32) + `","contractAddress":"` + addr + `"}`

	r, err := parseTronDeployResult(raw)
	require.NoError(t, err)
	assert.Equal(t, "0x"+strings.Repeat("ab", 32), r.TxHash.String())
	assert.Equal(t, addr, r.ContractAddress.String())

	for _, bad := range []string{
		"not json",
		`{"contractAddress":"` + addr + `"}`,            // missing txHash
		`{"txHash":"` + strings.Repeat("ab", 32) + `"}`, // missing contractAddress
	} {
		_, err := parseTronDeployResult(bad)
		assert.Error(t, err, "input %q", bad)
	}
}

func TestParseResultWrapsError(t *testing.T) {
	_, err := parseResult("nonsense", ParseTxHash)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "wallet returned invalid tx hash")
}
