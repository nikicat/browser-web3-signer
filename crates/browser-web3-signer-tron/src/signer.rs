//! [`TronSigner`]: typed wallet operations over TronLink, plus read-only balance queries via
//! TronGrid HTTP (ported from `browser-tron-signer/src/wallet-signer.ts`).
//!
//! Signing and transaction building happen browser-side in TronLink's `tronWeb`; the Rust side
//! only routes requests and performs read-only HTTP queries.

use alloy_primitives::U256;
use browser_web3_signer_core::{BindPort, BrowserChoice, Engine, Prepared, SignerError, TxHash};

use crate::config;
use crate::domain::{Decimals, Sun, Symbol, TokenAmount, TronAddress, TronNetwork};
use crate::types::{
    DeployContractParams, SendTransactionParams, TriggerContractParams, TronRequest, TypedData,
};

type Result<T> = std::result::Result<T, SignerError>;

/// The embedded browser approval UI.
pub const WEB_UI: &str = include_str!("../../../web/tron.html");

/// Native TRX balance of an address. Carries domain values; the caller formats for display.
#[derive(Debug, Clone)]
pub struct BalanceResult {
    /// Balance in SUN.
    pub amount: Sun,
    /// Native currency symbol.
    pub symbol: Symbol,
}

/// TRC-20 token balance of an address.
#[derive(Debug, Clone)]
pub struct TokenBalanceResult {
    /// The balance, self-describing (raw value + decimals).
    pub amount: TokenAmount,
    /// Token symbol (empty if the contract does not implement `symbol()`).
    pub symbol: Symbol,
}

/// Result of a contract deployment.
#[derive(Debug, Clone)]
pub struct DeployResult {
    /// Broadcast transaction hash.
    pub tx_hash: TxHash,
    /// The deployed contract's address.
    pub contract_address: TronAddress,
}

/// Programmatic TRON signer. Owns a single-network [`Engine`] plus a default network.
pub struct TronSigner {
    engine: Engine<TronRequest>,
    default_network: TronNetwork,
    http: reqwest::Client,
}

impl TronSigner {
    /// Create a signer that binds per `bind` and defaults to `default_network`.
    pub fn new(bind: BindPort, default_network: TronNetwork, browser: BrowserChoice) -> Self {
        Self {
            engine: Engine::new(WEB_UI, bind, browser),
            default_network,
            http: reqwest::Client::new(),
        }
    }

    /// Build a signer from environment configuration with the given browser choice.
    pub fn from_env(browser: BrowserChoice) -> Self {
        Self::new(
            BindPort::Preferred(config::port()),
            config::default_network(),
            browser,
        )
    }

    /// The default network.
    pub fn default_network(&self) -> TronNetwork {
        self.default_network
    }

    /// The underlying engine (used by the CLI to print the approval URL before opening).
    pub fn engine(&self) -> &Engine<TronRequest> {
        &self.engine
    }

    /// Register a request without opening a browser, returning the approval URL and result future.
    pub async fn prepare(&self, request: TronRequest) -> Result<Prepared> {
        let kind = request.url_kind();
        self.engine.prepare(request, kind).await
    }

    /// Open a URL via the engine's configured browser.
    pub fn open(&self, url: &browser_web3_signer_core::Url) {
        self.engine.open(url);
    }

    /// Shut the bridge down.
    pub async fn shutdown(&self) {
        self.engine.shutdown().await;
    }

    fn network_or_default(&self, network: Option<TronNetwork>) -> TronNetwork {
        network.unwrap_or(self.default_network)
    }

    async fn submit(&self, request: TronRequest) -> Result<String> {
        let kind = request.url_kind();
        self.engine.submit(request, kind).await
    }

    /// Connect TronLink, returning the connected address.
    pub async fn connect_wallet(
        &self,
        network: Option<TronNetwork>,
        address: Option<TronAddress>,
    ) -> Result<TronAddress> {
        let req = TronRequest::connect(Some(self.network_or_default(network)), address);
        parse_signed(&self.submit(req).await?, "tron address")
    }

    /// Send a native TRX transfer, returning the tx hash.
    pub async fn send_transaction(&self, mut params: SendTransactionParams) -> Result<TxHash> {
        params.network = Some(self.network_or_default(params.network));
        let req = TronRequest::send_transaction(params);
        parse_signed(&self.submit(req).await?, "tx hash")
    }

    /// Trigger a smart-contract function, returning the tx hash.
    pub async fn trigger_contract(&self, mut params: TriggerContractParams) -> Result<TxHash> {
        params.network = Some(self.network_or_default(params.network));
        let req = TronRequest::trigger_contract(params);
        parse_signed(&self.submit(req).await?, "tx hash")
    }

    /// Deploy a smart contract, returning the tx hash and the deployed contract address.
    pub async fn deploy_contract(&self, mut params: DeployContractParams) -> Result<DeployResult> {
        params.network = Some(self.network_or_default(params.network));
        let req = TronRequest::deploy_contract(params);
        parse_deploy_result(&self.submit(req).await?)
    }

    /// `signMessageV2` a message, returning the signature.
    pub async fn sign_message(
        &self,
        message: String,
        address: Option<TronAddress>,
        network: Option<TronNetwork>,
    ) -> Result<browser_web3_signer_core::Signature> {
        let req =
            TronRequest::sign_message(message, address, Some(self.network_or_default(network)));
        parse_signed(&self.submit(req).await?, "signature")
    }

    /// Sign TIP-712 typed data, returning the signature.
    pub async fn sign_typed_data(
        &self,
        typed_data: TypedData,
        address: Option<TronAddress>,
        network: Option<TronNetwork>,
    ) -> Result<browser_web3_signer_core::Signature> {
        let req = TronRequest::sign_typed_data(
            typed_data,
            address,
            Some(self.network_or_default(network)),
        );
        parse_signed(&self.submit(req).await?, "signature")
    }

    /// Read the native TRX balance of an address (no browser interaction).
    pub async fn get_balance(
        &self,
        address: &TronAddress,
        network: Option<TronNetwork>,
    ) -> Result<BalanceResult> {
        let network = self.network_or_default(network);
        let host = config::full_host(network)
            .ok_or_else(|| SignerError::Invalid(format!("unknown TRON network {network}")))?;

        let resp: serde_json::Value = self
            .http
            .post(format!("{host}/wallet/getaccount"))
            .json(&serde_json::json!({ "address": address.to_base58(), "visible": true }))
            .send()
            .await
            .map_err(|e| SignerError::Rpc(e.to_string()))?
            .json()
            .await
            .map_err(|e| SignerError::Rpc(e.to_string()))?;

        let sun = resp.get("balance").and_then(|b| b.as_u64()).unwrap_or(0);
        let symbol = Symbol::new(
            config::network_config(network)
                .map(|n| n.symbol)
                .unwrap_or("TRX"),
        );
        Ok(BalanceResult {
            amount: Sun(sun),
            symbol,
        })
    }

    /// Read the TRC-20 token balance of an address via `triggerconstantcontract` (no browser).
    pub async fn get_token_balance(
        &self,
        contract: &TronAddress,
        address: &TronAddress,
        network: Option<TronNetwork>,
    ) -> Result<TokenBalanceResult> {
        let network = self.network_or_default(network);
        let host = config::full_host(network)
            .ok_or_else(|| SignerError::Invalid(format!("unknown TRON network {network}")))?;

        let holder_arg = format!("{:0>64}", address.to_hex20());
        let raw_hex = self
            .trigger_constant(host, contract, "balanceOf(address)", &holder_arg)
            .await?;
        let decimals_hex = self
            .trigger_constant(host, contract, "decimals()", "")
            .await?;
        let symbol = match self.trigger_constant(host, contract, "symbol()", "").await {
            Ok(hex) => Symbol::new(decode_abi_string(&hex)),
            Err(_) => Symbol::new(""),
        };

        let raw = U256::from_str_radix(raw_hex.trim_start_matches("0x"), 16)
            .map_err(|e| SignerError::Rpc(format!("bad balanceOf result: {e}")))?;
        let decimals = u8::from_str_radix(decimals_hex.trim_start_matches("0x"), 16).unwrap_or(0);

        Ok(TokenBalanceResult {
            amount: TokenAmount::new(raw, Decimals(decimals)),
            symbol,
        })
    }

    /// POST a `triggerconstantcontract` read call; return the first `constant_result` hex string.
    async fn trigger_constant(
        &self,
        host: &str,
        contract: &TronAddress,
        function_selector: &str,
        parameter: &str,
    ) -> Result<String> {
        let resp: serde_json::Value = self
            .http
            .post(format!("{host}/wallet/triggerconstantcontract"))
            .json(&serde_json::json!({
                // A valid owner is required; the contract itself always qualifies and avoids
                // needing a real holder for read-only calls.
                "owner_address": contract.to_base58(),
                "contract_address": contract.to_base58(),
                "function_selector": function_selector,
                "parameter": parameter,
                "visible": true,
            }))
            .send()
            .await
            .map_err(|e| SignerError::Rpc(e.to_string()))?
            .json()
            .await
            .map_err(|e| SignerError::Rpc(e.to_string()))?;

        resp.get("constant_result")
            .and_then(|r| r.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| SignerError::Rpc(format!("triggerconstantcontract: no result ({resp})")))
    }
}

/// Parse a `deploy_contract` result (JSON `{txHash, contractAddress}`) into typed values.
pub fn parse_deploy_result(raw: &str) -> Result<DeployResult> {
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| SignerError::Invalid(format!("malformed deploy result {raw:?}: {e}")))?;
    let tx_hash = parsed
        .get("txHash")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SignerError::Invalid(format!("deploy result missing txHash: {raw}")))?
        .parse::<TxHash>()
        .map_err(SignerError::Invalid)?;
    let contract_address = parsed
        .get("contractAddress")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            SignerError::Invalid(format!("deploy result missing contractAddress: {raw}"))
        })?
        .parse::<TronAddress>()
        .map_err(|e| SignerError::Invalid(e.to_string()))?;
    Ok(DeployResult {
        tx_hash,
        contract_address,
    })
}

/// Decode an ABI-encoded `string` return value (offset + length + utf-8 bytes).
fn decode_abi_string(hex: &str) -> String {
    let hex = hex.trim_start_matches("0x");
    if hex.len() < 128 {
        return String::new();
    }
    let length = usize::from_str_radix(&hex[64..128], 16).unwrap_or(0);
    if length == 0 {
        return String::new();
    }
    let data = &hex[128..(128 + length * 2).min(hex.len())];
    let bytes = (0..data.len() / 2)
        .filter_map(|i| u8::from_str_radix(&data[i * 2..i * 2 + 2], 16).ok())
        .collect::<Vec<u8>>();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Parse a wallet-returned string into a domain type, mapping failures to an error.
fn parse_signed<T: std::str::FromStr>(raw: &str, what: &str) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    raw.parse::<T>()
        .map_err(|e| SignerError::Invalid(format!("wallet returned invalid {what} {raw:?}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_result_parses() {
        let raw = r#"{"txHash":"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899","contractAddress":"TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"}"#;
        let r = parse_deploy_result(raw).unwrap();
        assert_eq!(r.tx_hash.to_hex().len(), 64);
        assert_eq!(
            r.contract_address.to_base58(),
            "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"
        );
    }

    #[test]
    fn abi_string_decodes() {
        // offset(32) + length(5) + "USDTT" padded.
        let hex = format!(
            "{:064x}{:064x}{:0<64}",
            32u64,
            5u64,
            alloy_primitives::hex::encode("USDTT")
        );
        assert_eq!(decode_abi_string(&hex), "USDTT");
    }
}
