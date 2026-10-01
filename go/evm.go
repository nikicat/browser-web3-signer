package signer

import (
	"context"
	"errors"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

// EVMClient signs EVM transactions and messages with the user's browser wallet, over a
// managed `serve --chain evm` subprocess. Construct one with [NewEVMClient] and reuse it.
//
// Numeric amounts and fees are decimal-string wei (e.g. "1000000000000000000"); chain ids
// are plain integers. Addresses are 0x-hex. Results are go-ethereum domain types
// ([common.Address], [common.Hash], [hexutil.Bytes]), validated as they cross back from
// the wallet.
type EVMClient struct {
	core
}

// NewEVMClient creates an EVM client. The `serve` subprocess is spawned lazily on the
// first request (or eagerly via [EVMClient.Start]).
func NewEVMClient(opts ClientOptions) *EVMClient {
	return &EVMClient{core: newCore(ChainEVM, opts)}
}

// EVMConnectParams are the optional parameters for [EVMClient.Connect].
type EVMConnectParams struct {
	// ChainID to connect/switch to (0 = use the client's DefaultChainID, if any).
	ChainID int64 `json:"chainId,omitempty"`
	// Address the connected wallet must match; a mismatch is rejected.
	Address string `json:"address,omitempty"`
	// RPCURL for a custom/non-built-in chain, added via wallet_addEthereumChain at connect.
	RPCURL string `json:"rpcUrl,omitempty"`
	// ChainName is the human-readable name for a custom chain added via RPCURL.
	ChainName string `json:"chainName,omitempty"`
}

// EVMSendTxParams are the parameters for [EVMClient.SendTransaction]. To is required; the
// rest are optional. Amounts/fees are decimal-string wei.
type EVMSendTxParams struct {
	To                   string `json:"to"`
	From                 string `json:"from,omitempty"`
	Value                string `json:"value,omitempty"`
	Data                 string `json:"data,omitempty"`
	ChainID              int64  `json:"chainId,omitempty"`
	GasLimit             string `json:"gasLimit,omitempty"`
	MaxFeePerGas         string `json:"maxFeePerGas,omitempty"`
	MaxPriorityFeePerGas string `json:"maxPriorityFeePerGas,omitempty"`
}

// The message [EVMClient.SignMessage] signs and who signs it; the message is Message or Raw,
// never both.
type EVMSignMessageParams struct {
	// Text, signed as its UTF-8 bytes.
	Message string
	// Bytes signed unchanged, such as a hash a Safe expects signed as-is; Message must be empty.
	Raw     hexutil.Bytes
	Address string
	ChainID int64
}

// The wire shape of a sign_message request: Message is a string, or {"raw": "0x…"} for bytes.
type signMessageRequest struct {
	Type    string `json:"type"`
	Message any    `json:"message"`
	Address string `json:"address,omitempty"`
	ChainID int64  `json:"chainId,omitempty"`
}

// Returned by [EVMClient.SignMessage] for params that set both Message and Raw.
var errMessageAndRaw = errors.New("sign message: set Message or Raw, not both")

// EVMSignTypedDataParams are the parameters for [EVMClient.SignTypedData] (EIP-712). The
// domain/types/message sub-objects are open-ended.
type EVMSignTypedDataParams struct {
	Domain      map[string]any `json:"domain,omitempty"`
	Types       map[string]any `json:"types,omitempty"`
	PrimaryType string         `json:"primaryType"`
	Message     map[string]any `json:"message,omitempty"`
	Address     string         `json:"address,omitempty"`
	ChainID     int64          `json:"chainId,omitempty"`
}

// withDefault returns id, or the client default when id is 0.
func (c *core) evmChainID(id int64) int64 {
	if id == 0 {
		return c.defaultChainID
	}
	return id
}

// Connect connects a wallet and returns the connected address.
func (c *EVMClient) Connect(ctx context.Context, params EVMConnectParams) (common.Address, error) {
	params.ChainID = c.evmChainID(params.ChainID)
	raw, err := c.request(ctx, struct {
		Type string `json:"type"`
		EVMConnectParams
	}{Type: "connect", EVMConnectParams: params})
	if err != nil {
		return common.Address{}, err
	}
	return parseResult(raw, ParseAddress)
}

// SendTransaction sends a transaction (or contract call) and returns the tx hash.
func (c *EVMClient) SendTransaction(ctx context.Context, params EVMSendTxParams) (common.Hash, error) {
	params.ChainID = c.evmChainID(params.ChainID)
	raw, err := c.request(ctx, struct {
		Type string `json:"type"`
		EVMSendTxParams
	}{Type: "send_transaction", EVMSendTxParams: params})
	if err != nil {
		return common.Hash{}, err
	}
	return parseResult(raw, ParseTxHash)
}

// Asks the wallet to personal_sign the message and returns the signature. Errors without
// contacting the wallet when params sets both Message and Raw.
func (c *EVMClient) SignMessage(ctx context.Context, params EVMSignMessageParams) (hexutil.Bytes, error) {
	if params.Message != "" && params.Raw != nil {
		return nil, errMessageAndRaw
	}
	var message any = params.Message
	if params.Raw != nil {
		message = map[string]hexutil.Bytes{"raw": params.Raw}
	}
	raw, err := c.request(ctx, signMessageRequest{
		Type:    "sign_message",
		Message: message,
		Address: params.Address,
		ChainID: c.evmChainID(params.ChainID),
	})
	if err != nil {
		return nil, err
	}
	return parseResult(raw, ParseSignature)
}

// SignTypedData signs EIP-712 typed data and returns the signature.
func (c *EVMClient) SignTypedData(ctx context.Context, params EVMSignTypedDataParams) (hexutil.Bytes, error) {
	params.ChainID = c.evmChainID(params.ChainID)
	raw, err := c.request(ctx, struct {
		Type string `json:"type"`
		EVMSignTypedDataParams
	}{Type: "sign_typed_data", EVMSignTypedDataParams: params})
	if err != nil {
		return nil, err
	}
	return parseResult(raw, ParseSignature)
}
