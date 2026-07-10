//! [`EvmSigner`]: typed wallet operations over a browser wallet
//! (ported from `browser-evm-signer/src/wallet-signer.ts`).

use browser_web3_signer_core::{BindPort, BrowserChoice, Engine, Prepared, SignerError};

use crate::config;
use crate::domain::{Address, ChainId, Signature, TxHash};
use crate::types::{EvmRequest, SendTransactionParams, TypedData};

type Result<T> = std::result::Result<T, SignerError>;

/// The embedded browser approval UI.
pub const WEB_UI: &str = include_str!("../web/evm.html");

/// Programmatic EVM signer. Owns a single-chain [`Engine`] plus a default chain id used when a
/// request omits one.
pub struct EvmSigner {
    engine: Engine<EvmRequest>,
    default_chain_id: ChainId,
}

impl EvmSigner {
    /// Create a signer that binds per `bind` and defaults to `default_chain_id`.
    pub fn new(bind: BindPort, default_chain_id: ChainId, browser: BrowserChoice) -> Self {
        Self {
            engine: Engine::new(WEB_UI, bind, browser),
            default_chain_id,
        }
    }

    /// Build a signer from environment configuration with the given browser choice.
    pub fn from_env(browser: BrowserChoice) -> Self {
        Self::new(
            BindPort::Preferred(config::port()),
            config::default_chain_id(),
            browser,
        )
    }

    /// The default chain id.
    pub const fn default_chain_id(&self) -> ChainId {
        self.default_chain_id
    }

    /// The underlying engine (used by the CLI to print the approval URL before opening, and by
    /// the daemon to extend the router).
    pub const fn engine(&self) -> &Engine<EvmRequest> {
        &self.engine
    }

    /// Register a request without opening a browser, returning the approval URL and a result
    /// future. The CLI uses this to print the URL first.
    pub async fn prepare(&self, request: EvmRequest) -> Result<Prepared> {
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

    fn chain_or_default(&self, chain_id: Option<ChainId>) -> ChainId {
        chain_id.unwrap_or(self.default_chain_id)
    }

    async fn submit(&self, request: EvmRequest) -> Result<String> {
        self.engine.submit(request).await
    }

    /// Connect a wallet, returning the connected address.
    pub async fn connect_wallet(
        &self,
        chain_id: Option<ChainId>,
        address: Option<Address>,
    ) -> Result<Address> {
        let req = EvmRequest::connect(Some(self.chain_or_default(chain_id)), address);
        parse_signed(&self.submit(req).await?, "address")
    }

    /// Send a transaction, returning its hash.
    pub async fn send_transaction(&self, mut params: SendTransactionParams) -> Result<TxHash> {
        params.chain_id = Some(self.chain_or_default(params.chain_id));
        let req = EvmRequest::send_transaction(params);
        parse_signed(&self.submit(req).await?, "tx hash")
    }

    /// `personal_sign` a message, returning the signature.
    pub async fn sign_message(
        &self,
        message: String,
        address: Option<Address>,
        chain_id: Option<ChainId>,
    ) -> Result<Signature> {
        let req = EvmRequest::sign_message(message, address, Some(self.chain_or_default(chain_id)));
        parse_signed(&self.submit(req).await?, "signature")
    }

    /// Sign EIP-712 typed data, returning the signature.
    pub async fn sign_typed_data(
        &self,
        typed_data: TypedData,
        address: Option<Address>,
        chain_id: Option<ChainId>,
    ) -> Result<Signature> {
        let req =
            EvmRequest::sign_typed_data(typed_data, address, Some(self.chain_or_default(chain_id)));
        parse_signed(&self.submit(req).await?, "signature")
    }
}

/// Parse a wallet-returned string into a domain type, mapping failures to an error.
fn parse_signed<T: std::str::FromStr>(raw: &str, what: &str) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    raw.parse::<T>()
        .map_err(|e| SignerError::Invalid(format!("wallet returned invalid {what} {raw:?}: {e}")))
}
