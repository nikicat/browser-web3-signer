package signer

import (
	"context"
	"encoding/json"
)

// TronClient signs TRON transactions and messages with the user's TronLink wallet, over a
// managed `serve --chain tron` subprocess. Construct one with [NewTronClient] and reuse it.
//
// Amounts (SUN), fee limits, energy limits, and the fee percentage are all decimal
// strings on the wire (e.g. Amount "1500000"); addresses are Base58Check. Network is one
// of "mainnet", "shasta", "nile".
type TronClient struct {
	core
}

// NewTronClient creates a TRON client. The `serve` subprocess is spawned lazily on the
// first request (or eagerly via [TronClient.Start]).
func NewTronClient(opts ClientOptions) *TronClient {
	return &TronClient{core: newCore(ChainTRON, opts)}
}

// TronParam is one ABI parameter for a contract call or deployment (`{type, value}`).
type TronParam struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

// TronConnectParams are the optional parameters for [TronClient.Connect].
type TronConnectParams struct {
	Network string `json:"network,omitempty"`
	Address string `json:"address,omitempty"`
}

// TronSendTxParams are the parameters for [TronClient.SendTransaction] (native TRX
// transfer). To and Amount (SUN) are required.
type TronSendTxParams struct {
	To      string `json:"to"`
	From    string `json:"from,omitempty"`
	Amount  string `json:"amount"`
	Data    string `json:"data,omitempty"`
	Network string `json:"network,omitempty"`
}

// TronTriggerContractParams are the parameters for [TronClient.TriggerContract].
// ContractAddress and FunctionSelector (e.g. "transfer(address,uint256)") are required.
type TronTriggerContractParams struct {
	ContractAddress  string      `json:"contractAddress"`
	From             string      `json:"from,omitempty"`
	FunctionSelector string      `json:"functionSelector"`
	Parameters       []TronParam `json:"parameters,omitempty"`
	FeeLimit         string      `json:"feeLimit,omitempty"`
	CallValue        string      `json:"callValue,omitempty"`
	Network          string      `json:"network,omitempty"`
}

// TronDeployContractParams are the parameters for [TronClient.DeployContract]. ABI (a JSON
// array) and Bytecode (0x-hex) are required.
type TronDeployContractParams struct {
	ABI               json.RawMessage `json:"abi"`
	Bytecode          string          `json:"bytecode"`
	ContractName      string          `json:"contractName,omitempty"`
	Parameters        []TronParam     `json:"parameters,omitempty"`
	From              string          `json:"from,omitempty"`
	FeeLimit          string          `json:"feeLimit,omitempty"`
	CallValue         string          `json:"callValue,omitempty"`
	OriginEnergyLimit string          `json:"originEnergyLimit,omitempty"`
	UserFeePercentage string          `json:"userFeePercentage,omitempty"`
	Network           string          `json:"network,omitempty"`
}

// TronSignMessageParams are the parameters for [TronClient.SignMessage] (signMessageV2).
type TronSignMessageParams struct {
	Message string `json:"message"`
	Address string `json:"address,omitempty"`
	Network string `json:"network,omitempty"`
}

// TronSignTypedDataParams are the parameters for [TronClient.SignTypedData] (TIP-712). The
// domain/types/message sub-objects are open-ended.
type TronSignTypedDataParams struct {
	Domain      map[string]any `json:"domain,omitempty"`
	Types       map[string]any `json:"types,omitempty"`
	PrimaryType string         `json:"primaryType"`
	Message     map[string]any `json:"message,omitempty"`
	Address     string         `json:"address,omitempty"`
	Network     string         `json:"network,omitempty"`
}

// Connect connects a TronLink wallet and returns the connected Base58Check address.
func (c *TronClient) Connect(ctx context.Context, params TronConnectParams) (string, error) {
	return c.request(ctx, struct {
		Type string `json:"type"`
		TronConnectParams
	}{Type: "connect", TronConnectParams: params})
}

// SendTransaction sends a native TRX transfer and returns the tx hash.
func (c *TronClient) SendTransaction(ctx context.Context, params TronSendTxParams) (string, error) {
	return c.request(ctx, struct {
		Type string `json:"type"`
		TronSendTxParams
	}{Type: "send_transaction", TronSendTxParams: params})
}

// TriggerContract calls a smart contract and returns the tx hash.
func (c *TronClient) TriggerContract(ctx context.Context, params TronTriggerContractParams) (string, error) {
	return c.request(ctx, struct {
		Type string `json:"type"`
		TronTriggerContractParams
	}{Type: "trigger_contract", TronTriggerContractParams: params})
}

// DeployContract deploys a smart contract and returns the tx hash.
func (c *TronClient) DeployContract(ctx context.Context, params TronDeployContractParams) (string, error) {
	return c.request(ctx, struct {
		Type string `json:"type"`
		TronDeployContractParams
	}{Type: "deploy_contract", TronDeployContractParams: params})
}

// SignMessage signs a message (TIP-191) and returns the signature.
func (c *TronClient) SignMessage(ctx context.Context, params TronSignMessageParams) (string, error) {
	return c.request(ctx, struct {
		Type string `json:"type"`
		TronSignMessageParams
	}{Type: "sign_message", TronSignMessageParams: params})
}

// SignTypedData signs TIP-712 typed data and returns the signature.
func (c *TronClient) SignTypedData(ctx context.Context, params TronSignTypedDataParams) (string, error) {
	return c.request(ctx, struct {
		Type string `json:"type"`
		TronSignTypedDataParams
	}{Type: "sign_typed_data", TronSignTypedDataParams: params})
}
