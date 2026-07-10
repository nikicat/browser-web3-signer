//! [`TronSigner`]: typed wallet operations over TronLink
//! (ported from `browser-tron-signer/src/wallet-signer.ts`).
//!
//! Signing and transaction building happen browser-side in TronLink's `tronWeb`; the Rust side
//! only routes requests.

use browser_web3_signer_core::{BindPort, BrowserChoice, Engine, Prepared, SignerError, TxHash};

use crate::config;
use crate::domain::{TronAddress, TronNetwork};
use crate::types::{
    DeployContractParams, SendTransactionParams, TriggerContractParams, TronRequest, TypedData,
};

type Result<T> = std::result::Result<T, SignerError>;

/// The embedded browser approval UI.
pub const WEB_UI: &str = include_str!("../web/tron.html");

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
}

impl TronSigner {
    /// Create a signer that binds per `bind` and defaults to `default_network`.
    pub fn new(bind: BindPort, default_network: TronNetwork, browser: BrowserChoice) -> Self {
        Self {
            engine: Engine::new(WEB_UI, bind, browser),
            default_network,
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
    pub const fn default_network(&self) -> TronNetwork {
        self.default_network
    }

    /// The underlying engine (used by the CLI to print the approval URL before opening).
    pub const fn engine(&self) -> &Engine<TronRequest> {
        &self.engine
    }

    /// Register a request without opening a browser, returning the approval URL and result future.
    pub async fn prepare(&self, request: TronRequest) -> Result<Prepared> {
        self.engine.prepare(request).await
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
        self.engine.submit(request).await
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
}
