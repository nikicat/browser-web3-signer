//! [`EvmSigner`]: typed wallet operations over a browser wallet, plus read-only balance
//! queries via `alloy` (ported from `browser-evm-signer/src/wallet-signer.ts`).

use alloy::providers::{Provider, ProviderBuilder};
use alloy::sol;
use browser_web3_signer_core::{BindPort, BrowserChoice, Engine, Prepared, SignerError};

use crate::config;
use crate::domain::{Address, ChainId, Decimals, Signature, Symbol, TokenAmount, TxHash, Wei};
use crate::types::{EvmRequest, SendTransactionParams, TypedData};

type Result<T> = std::result::Result<T, SignerError>;

/// The embedded browser approval UI.
pub const WEB_UI: &str = include_str!("../../../web/evm.html");

sol! {
    #[sol(rpc)]
    interface IERC20 {
        function balanceOf(address owner) external view returns (uint256);
        function decimals() external view returns (uint8);
        function symbol() external view returns (string);
    }
}

/// Native-token balance of an address. Carries only domain values; the caller formats for display.
#[derive(Debug, Clone)]
pub struct BalanceResult {
    /// The balance in wei.
    pub amount: Wei,
    /// Native currency symbol.
    pub symbol: Symbol,
}

impl BalanceResult {
    /// Human-readable balance (18-decimal native currency).
    pub fn to_decimal_string(&self) -> String {
        self.amount.to_ether_string()
    }
}

/// ERC-20 token balance of an address.
#[derive(Debug, Clone)]
pub struct TokenBalanceResult {
    /// The balance, self-describing (raw value + decimals).
    pub amount: TokenAmount,
    /// Token symbol (empty if the contract does not implement `symbol()`).
    pub symbol: Symbol,
}

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
    pub fn default_chain_id(&self) -> ChainId {
        self.default_chain_id
    }

    /// The underlying engine (used by the CLI to print the approval URL before opening, and by
    /// the daemon to extend the router).
    pub fn engine(&self) -> &Engine<EvmRequest> {
        &self.engine
    }

    /// Register a request without opening a browser, returning the approval URL and a result
    /// future. The CLI uses this to print the URL first.
    pub async fn prepare(&self, request: EvmRequest) -> Result<Prepared> {
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

    fn chain_or_default(&self, chain_id: Option<ChainId>) -> ChainId {
        chain_id.unwrap_or(self.default_chain_id)
    }

    async fn submit(&self, request: EvmRequest) -> Result<String> {
        let kind = request.url_kind();
        self.engine.submit(request, kind).await
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

    /// Read the native balance of an address (no browser interaction).
    pub async fn get_balance(
        &self,
        address: Address,
        chain_id: Option<ChainId>,
    ) -> Result<BalanceResult> {
        let chain_id = self.chain_or_default(chain_id);
        let provider = provider_for(chain_id)?;
        let wei = provider
            .get_balance(address.inner())
            .await
            .map_err(|e| SignerError::Rpc(e.to_string()))?;
        let symbol = Symbol::new(
            config::chain_config(chain_id)
                .map(|c| c.symbol)
                .unwrap_or("ETH"),
        );
        Ok(BalanceResult {
            amount: Wei(wei),
            symbol,
        })
    }

    /// Read the ERC-20 token balance of an address (no browser interaction). `symbol` is empty
    /// if the contract does not implement `symbol()`.
    pub async fn get_token_balance(
        &self,
        contract: Address,
        address: Address,
        chain_id: Option<ChainId>,
    ) -> Result<TokenBalanceResult> {
        let chain_id = self.chain_or_default(chain_id);
        let provider = provider_for(chain_id)?;
        let token = IERC20::new(contract.inner(), &provider);

        let raw = token
            .balanceOf(address.inner())
            .call()
            .await
            .map_err(|e| SignerError::Rpc(e.to_string()))?;
        let decimals = token
            .decimals()
            .call()
            .await
            .map_err(|e| SignerError::Rpc(e.to_string()))?;
        let symbol = Symbol::new(token.symbol().call().await.unwrap_or_default());

        Ok(TokenBalanceResult {
            amount: TokenAmount::new(raw, Decimals(decimals)),
            symbol,
        })
    }
}

/// Build a read-only HTTP provider for a chain.
fn provider_for(chain_id: ChainId) -> Result<impl Provider> {
    let url = config::rpc_url(chain_id)
        .ok_or_else(|| SignerError::Invalid(format!("unknown chain id {chain_id}; no RPC URL")))?;
    let url = url
        .parse()
        .map_err(|e| SignerError::Invalid(format!("bad RPC URL: {e}")))?;
    Ok(ProviderBuilder::new().connect_http(url))
}

/// Parse a wallet-returned string into a domain type, mapping failures to an error.
fn parse_signed<T: std::str::FromStr>(raw: &str, what: &str) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    raw.parse::<T>()
        .map_err(|e| SignerError::Invalid(format!("wallet returned invalid {what} {raw:?}: {e}")))
}
