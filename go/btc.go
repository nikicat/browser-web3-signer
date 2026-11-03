package signer

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// BtcClient signs Bitcoin transfers, PSBTs and messages with the user's browser wallet
// (Unisat, Leather), over a managed `serve --chain btc` subprocess. Construct one with
// [NewBtcClient] and reuse it.
//
// Network is one of "mainnet", "testnet", "testnet4", "signet", "regtest" (empty: the
// `serve` process's default, BROWSER_WEB3_BTC_NETWORK or mainnet). Amounts are sats and fee
// rates sat/vB. `serve` checks every result against its request before returning it (the
// address is on the request's network, a signed PSBT is for the same transaction, a
// broadcast txid matches), so this client only decodes. PSBTs are raw bytes, to load with
// whichever PSBT library the caller uses.
type BtcClient struct {
	core
}

// NewBtcClient creates a Bitcoin client. The `serve` subprocess is spawned lazily on the
// first request (or eagerly via [BtcClient.Start]).
func NewBtcClient(opts ClientOptions) *BtcClient {
	return &BtcClient{core: newCore(ChainBTC, opts)}
}

// BtcConnectParams are the optional parameters for [BtcClient.Connect].
type BtcConnectParams struct {
	Network string `json:"network,omitempty"`
	// Address the connected wallet must match; a mismatch is rejected.
	Address string `json:"address,omitempty"`
}

// BtcSendTransferParams are the parameters for [BtcClient.SendTransfer]: pay To Amount
// sats. The wallet selects coins, signs and broadcasts.
type BtcSendTransferParams struct {
	To     string `json:"to"`
	Amount uint64 `json:"amount,string"`
	// From is the expected sender; a mismatch is rejected.
	From string `json:"from,omitempty"`
	// FeeRate is a sat/vB hint (0: the wallet's choice).
	FeeRate uint64 `json:"feeRate,omitempty,string"`
	Network string `json:"network,omitempty"`
}

// BtcSignPsbtParams are the parameters for [BtcClient.SignPsbt].
type BtcSignPsbtParams struct {
	// Psbt is the serialized PSBT (sent base64).
	Psbt []byte `json:"psbt"`
	// SignInputs are the input indexes to sign (empty: every input the wallet owns).
	SignInputs []uint32 `json:"signInputs,omitempty"`
	// Finalize the signed inputs. Leather finalizes only when broadcasting.
	Finalize bool `json:"finalize,omitempty"`
	// Broadcast through the wallet after signing (implies Finalize).
	Broadcast bool `json:"broadcast,omitempty"`
	// From is the expected signer; a mismatch is rejected.
	From    string `json:"from,omitempty"`
	Network string `json:"network,omitempty"`
}

// BtcSignMessageParams are the parameters for [BtcClient.SignMessage].
type BtcSignMessageParams struct {
	Message string `json:"message"`
	// Address to sign with (empty: the wallet's).
	Address string `json:"address,omitempty"`
	// Protocol is "bip322" (default) or "ecdsa".
	Protocol string `json:"protocol,omitempty"`
	Network  string `json:"network,omitempty"`
}

// BtcTxid is a Bitcoin transaction id, stored in its displayed byte order (the order
// explorers and bitcoind print, the reverse of the hash bytes).
type BtcTxid [32]byte

// ParseBtcTxid parses a txid from its 64-hex-digit display form.
func ParseBtcTxid(s string) (BtcTxid, error) {
	var t BtcTxid
	b, err := hex.DecodeString(s)
	if err != nil {
		return t, fmt.Errorf("invalid txid %q: %w", s, err)
	}
	if len(b) != len(t) {
		return t, fmt.Errorf("invalid txid %q: expected %d bytes, got %d", s, len(t), len(b))
	}
	copy(t[:], b)
	return t, nil
}

// String returns the 64-hex-digit display form.
func (t BtcTxid) String() string { return hex.EncodeToString(t[:]) }

// BtcSignedPsbt is the result of [BtcClient.SignPsbt].
type BtcSignedPsbt struct {
	// Psbt is the signed PSBT, serialized.
	Psbt []byte
	// Txid is the broadcast transaction's id; nil unless the request broadcast.
	Txid *BtcTxid
}

// parseBtcSignedPsbt parses a `sign_psbt` result (JSON `{psbt, txid?}`, the PSBT in hex or
// base64 as the wallet returned it).
func parseBtcSignedPsbt(raw string) (BtcSignedPsbt, error) {
	var wire struct {
		Psbt string  `json:"psbt"`
		Txid *string `json:"txid"`
	}
	if err := json.Unmarshal([]byte(raw), &wire); err != nil {
		return BtcSignedPsbt{}, fmt.Errorf("malformed sign_psbt result %q: %w", raw, err)
	}
	psbt, err := hex.DecodeString(wire.Psbt)
	if err != nil {
		if psbt, err = base64.StdEncoding.DecodeString(wire.Psbt); err != nil {
			return BtcSignedPsbt{}, fmt.Errorf("invalid psbt %q: neither hex nor base64", wire.Psbt)
		}
	}
	signed := BtcSignedPsbt{Psbt: psbt}
	if wire.Txid != nil {
		txid, err := ParseBtcTxid(*wire.Txid)
		if err != nil {
			return BtcSignedPsbt{}, err
		}
		signed.Txid = &txid
	}
	return signed, nil
}

// parseBase64Signature decodes a base64 message signature (BIP-322 or ECDSA).
func parseBase64Signature(s string) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) == 0 {
		return nil, fmt.Errorf("invalid signature %q: expected non-empty base64", s)
	}
	return b, nil
}

// Connect connects the wallet and returns its address (checked by `serve` to be on the
// request's network).
func (c *BtcClient) Connect(ctx context.Context, params BtcConnectParams) (string, error) {
	return c.request(ctx, struct {
		Type string `json:"type"`
		BtcConnectParams
	}{Type: "connect", BtcConnectParams: params})
}

// SendTransfer pays one address and returns the broadcast txid.
func (c *BtcClient) SendTransfer(ctx context.Context, params BtcSendTransferParams) (BtcTxid, error) {
	raw, err := c.request(ctx, struct {
		Type string `json:"type"`
		BtcSendTransferParams
	}{Type: "send_transfer", BtcSendTransferParams: params})
	if err != nil {
		return BtcTxid{}, err
	}
	return parseResult(raw, ParseBtcTxid)
}

// SignPsbt signs a PSBT and returns it, with the txid when it was broadcast.
func (c *BtcClient) SignPsbt(ctx context.Context, params BtcSignPsbtParams) (BtcSignedPsbt, error) {
	raw, err := c.request(ctx, struct {
		Type string `json:"type"`
		BtcSignPsbtParams
	}{Type: "sign_psbt", BtcSignPsbtParams: params})
	if err != nil {
		return BtcSignedPsbt{}, err
	}
	return parseResult(raw, parseBtcSignedPsbt)
}

// SignMessage signs a text message and returns the decoded signature (base64 on the wire).
func (c *BtcClient) SignMessage(ctx context.Context, params BtcSignMessageParams) ([]byte, error) {
	raw, err := c.request(ctx, struct {
		Type string `json:"type"`
		BtcSignMessageParams
	}{Type: "sign_message", BtcSignMessageParams: params})
	if err != nil {
		return nil, err
	}
	return parseResult(raw, parseBase64Signature)
}
