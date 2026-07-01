package signer

import "context"

// EVMClient signs EVM transactions and messages with the user's browser wallet, over a
// managed `serve --chain evm` subprocess. Construct one with [NewEVMClient] and reuse it.
//
// Numeric amounts and fees are decimal-string wei (e.g. "1000000000000000000"); chain ids
// are plain integers. Addresses are 0x-hex.
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

// EVMSignMessageParams are the parameters for [EVMClient.SignMessage]. Message is plain
// text (not hex-encoded).
type EVMSignMessageParams struct {
	Message string `json:"message"`
	Address string `json:"address,omitempty"`
	ChainID int64  `json:"chainId,omitempty"`
}

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
func (c *EVMClient) Connect(ctx context.Context, params EVMConnectParams) (string, error) {
	params.ChainID = c.evmChainID(params.ChainID)
	return c.request(ctx, struct {
		Type string `json:"type"`
		EVMConnectParams
	}{Type: "connect", EVMConnectParams: params})
}

// SendTransaction sends a transaction (or contract call) and returns the tx hash.
func (c *EVMClient) SendTransaction(ctx context.Context, params EVMSendTxParams) (string, error) {
	params.ChainID = c.evmChainID(params.ChainID)
	return c.request(ctx, struct {
		Type string `json:"type"`
		EVMSendTxParams
	}{Type: "send_transaction", EVMSendTxParams: params})
}

// SignMessage personal_signs a message and returns the signature.
func (c *EVMClient) SignMessage(ctx context.Context, params EVMSignMessageParams) (string, error) {
	params.ChainID = c.evmChainID(params.ChainID)
	return c.request(ctx, struct {
		Type string `json:"type"`
		EVMSignMessageParams
	}{Type: "sign_message", EVMSignMessageParams: params})
}

// SignTypedData signs EIP-712 typed data and returns the signature.
func (c *EVMClient) SignTypedData(ctx context.Context, params EVMSignTypedDataParams) (string, error) {
	params.ChainID = c.evmChainID(params.ChainID)
	return c.request(ctx, struct {
		Type string `json:"type"`
		EVMSignTypedDataParams
	}{Type: "sign_typed_data", EVMSignTypedDataParams: params})
}
