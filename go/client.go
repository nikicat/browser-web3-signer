package signer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// CodeWrongWalletAddress is the discriminating `code` the bridge attaches to a rejection
// when the connected wallet account differs from the address the caller required. It
// mirrors the Rust `code` module.
const CodeWrongWalletAddress = "WRONG_WALLET_ADDRESS"

// RequestError is a failed control-API request. Message is the bridge's error text; Code
// is the optional machine-readable discriminator (e.g. [CodeWrongWalletAddress]), empty
// when the bridge attached none.
type RequestError struct {
	Message string
	Code    string
}

func (e *RequestError) Error() string { return e.Message }

// WrongWalletAddressError is returned when the connected wallet account differs from the
// address the caller required (Code == [CodeWrongWalletAddress]). Match it with
// [errors.As]. It wraps the underlying [RequestError].
type WrongWalletAddressError struct {
	*RequestError
}

// ClientOptions configures an [EVMClient] or [TronClient] (and the `serve` subprocess it
// supervises).
type ClientOptions struct {
	// BinPath is an explicit path to the `browser-web3-signer` binary; see [ServeOptions].
	BinPath string
	// Browser controls how the approval page opens; see [ServeOptions].
	Browser string
	// DefaultChainID (EVM only) is sent when a request omits a chain id. 0 means unset.
	DefaultChainID int64
}

// response is the control API's envelope: `{success, result}` on success, or
// `{success:false, error, code?}` on failure.
type response struct {
	Success bool   `json:"success"`
	Result  string `json:"result"`
	Error   string `json:"error"`
	Code    string `json:"code"`
}

// core is the shared machinery behind the typed chain clients: it owns the managed `serve`
// subprocess and drives it over `POST /api/v1/request`.
type core struct {
	serve          *ServeProcess
	http           *http.Client
	defaultChainID int64
}

func newCore(chain Chain, opts ClientOptions) core {
	return core{
		serve:          NewServeProcess(chain, ServeOptions{BinPath: opts.BinPath, Browser: opts.Browser}),
		http:           &http.Client{},
		defaultChainID: opts.DefaultChainID,
	}
}

// Start spawns the `serve` subprocess (idempotent). It is called automatically on the
// first request; call it explicitly to surface spawn/port errors up front.
func (c *core) Start(ctx context.Context) error {
	_, err := c.serve.Start(ctx)
	return err
}

// Shutdown kills the `serve` subprocess and releases the port.
func (c *core) Shutdown() error {
	return c.serve.Stop()
}

// BaseURL returns the control-API base URL, or "" before the subprocess has started.
func (c *core) BaseURL() string {
	return c.serve.BaseURL()
}

// request POSTs a request body to the control API and unwraps its result, mapping a coded
// failure to a typed error ([WrongWalletAddressError]) and any other failure to
// [RequestError].
func (c *core) request(ctx context.Context, body any) (string, error) {
	baseURL, err := c.serve.Start(ctx)
	if err != nil {
		return "", err
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/v1/request", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	var env response
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil {
		return "", fmt.Errorf("decode response (HTTP %d): %w", res.StatusCode, err)
	}
	if env.Success && env.Result != "" {
		return env.Result, nil
	}

	message := env.Error
	if message == "" {
		message = fmt.Sprintf("request failed (HTTP %d)", res.StatusCode)
	}
	reqErr := &RequestError{Message: message, Code: env.Code}
	if env.Code == CodeWrongWalletAddress {
		return "", &WrongWalletAddressError{RequestError: reqErr}
	}
	return "", reqErr
}
