package signer

import (
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseAddress(t *testing.T) {
	// An EIP-55 test vector: the checksum is accepted, not enforced, and String() renders
	// lowercase.
	const checksummed = "0x52908400098527886E0F7030069857D2E4169EE7"

	a, err := ParseAddress(checksummed)
	require.NoError(t, err)
	assert.Equal(t, strings.ToLower(checksummed), a.String())

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
	assert.Equal(t, []byte{0xde, 0xad, 0xbe, 0xef}, []byte(s))

	for _, bad := range []string{"", "0x", "0xzz"} {
		_, err := ParseSignature(bad)
		assert.Error(t, err, "input %q", bad)
	}
}

func TestHexBytesMarshalsAsPrefixedHex(t *testing.T) {
	encoded, err := json.Marshal(map[string]HexBytes{"raw": {0xde, 0xad}})
	require.NoError(t, err)
	assert.JSONEq(t, `{"raw":"0xdead"}`, string(encoded))
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

func TestParseBtcTxid(t *testing.T) {
	const s = "75c5c9665a570569ad77dd1279e6fd4628a093c4dcbf8d41532614044c14c115"
	txid, err := ParseBtcTxid(s)
	require.NoError(t, err)
	assert.Equal(t, s, txid.String())

	for _, bad := range []string{"", "0x" + s, s[:62], s + "00", strings.Repeat("zz", 32)} {
		_, err := ParseBtcTxid(bad)
		assert.Error(t, err, "input %q", bad)
	}
}

func TestParseBtcAccount(t *testing.T) {
	const key = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
	a, err := parseBtcAccount(`{"address":"bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080","publicKey":"` + key + `"}`)
	require.NoError(t, err)
	assert.Equal(t, "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", a.Address)
	assert.Equal(t, key, hex.EncodeToString(a.PublicKey))

	for _, bad := range []string{"bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", `{"address":"x"}`, `{"address":"x","publicKey":"` + key[2:] + `"}`} {
		_, err := parseBtcAccount(bad)
		assert.Error(t, err, bad)
	}
}

func TestParseBtcSignedPsbt(t *testing.T) {
	const txid = "75c5c9665a570569ad77dd1279e6fd4628a093c4dcbf8d41532614044c14c115"
	psbt := []byte("psbt\xff\x00")

	// Hex without a txid (not broadcast) and base64 with one decode to the same bytes.
	r, err := parseBtcSignedPsbt(`{"psbt":"70736274ff00"}`)
	require.NoError(t, err)
	assert.Equal(t, psbt, r.Psbt)
	assert.Nil(t, r.Txid)

	r, err = parseBtcSignedPsbt(`{"psbt":"cHNidP8A","txid":"` + txid + `"}`)
	require.NoError(t, err)
	assert.Equal(t, psbt, r.Psbt)
	require.NotNil(t, r.Txid)
	assert.Equal(t, txid, r.Txid.String())

	for _, bad := range []string{"not json", `{"psbt":"!!"}`, `{"psbt":"00","txid":"nope"}`} {
		_, err := parseBtcSignedPsbt(bad)
		assert.Error(t, err, "input %q", bad)
	}
}
