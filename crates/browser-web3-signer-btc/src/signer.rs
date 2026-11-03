//! [`BtcSigner`]: typed wallet operations over Unisat.
//!
//! Coin selection, signing and broadcasting happen browser-side in the wallet; the Rust side
//! only routes requests and checks what comes back.

use bitcoin::Txid;
use browser_web3_signer_core::{BindPort, BrowserChoice, Engine, Prepared, SignerError, Url};

use crate::config;
use crate::domain::{
    BtcAddress, BtcNetwork, BtcPublicKey, MessageSignature, PsbtData, UncheckedAddress,
};
use crate::types::{BtcRequest, SendTransferParams, SignMessageParams, SignPsbtParams};

type Result<T> = std::result::Result<T, SignerError>;

/// The embedded browser approval UI.
pub const WEB_UI: &str = include_str!("../web/btc.html");

/// The connected wallet account: the result of a `connect` (JSON `{address, publicKey}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BtcAccount {
    /// The account's address, on the request's network.
    pub address: BtcAddress,
    /// The key that signs for the account, which a caller names in a Taproot script leaf for the
    /// wallet to sign through.
    pub public_key: BtcPublicKey,
}

/// Result of a `sign_psbt`, checked against the request (see [`parse_signed_psbt`]).
#[derive(Debug, Clone)]
pub struct SignedPsbt {
    /// The signed PSBT.
    pub psbt: PsbtData,
    /// The broadcast txid, when the request asked to broadcast.
    pub txid: Option<Txid>,
}

/// Programmatic Bitcoin signer. Owns a single [`Engine`] plus a default network.
pub struct BtcSigner {
    engine: Engine<BtcRequest>,
    default_network: BtcNetwork,
}

impl BtcSigner {
    /// Create a signer that binds per `bind` and defaults to `default_network`.
    pub fn new(bind: BindPort, default_network: BtcNetwork, browser: BrowserChoice) -> Self {
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
    pub const fn default_network(&self) -> BtcNetwork {
        self.default_network
    }

    /// The underlying engine (used by the CLI to print the approval URL before opening).
    pub const fn engine(&self) -> &Engine<BtcRequest> {
        &self.engine
    }

    /// Register a request without opening a browser, returning the approval URL and result future.
    pub async fn prepare(&self, request: BtcRequest) -> Result<Prepared> {
        self.engine.prepare(request).await
    }

    /// Open a URL via the engine's configured browser.
    pub fn open(&self, url: &Url) {
        self.engine.open(url);
    }

    /// Shut the bridge down.
    pub async fn shutdown(&self) {
        self.engine.shutdown().await;
    }

    async fn submit(&self, request: BtcRequest) -> Result<String> {
        self.engine.submit(request).await
    }

    /// Connect the wallet, returning its account.
    pub async fn connect_wallet(
        &self,
        network: Option<BtcNetwork>,
        address: Option<UncheckedAddress>,
    ) -> Result<BtcAccount> {
        let network = network.unwrap_or(self.default_network);
        let req = BtcRequest::connect(network, address).map_err(invalid)?;
        parse_account(&self.submit(req).await?, network)
    }

    /// Pay one address, returning the broadcast txid.
    pub async fn send_transfer(&self, params: SendTransferParams) -> Result<Txid> {
        let req = BtcRequest::send_transfer(params).map_err(invalid)?;
        parse_signed(&self.submit(req).await?, "txid")
    }

    /// Sign a PSBT, returning it (and the txid, if broadcast) after checking the wallet didn't
    /// change the transaction.
    pub async fn sign_psbt(&self, params: SignPsbtParams) -> Result<SignedPsbt> {
        let unsigned = params.psbt.clone();
        let req = BtcRequest::sign_psbt(params).map_err(invalid)?;
        parse_signed_psbt(&unsigned, &self.submit(req).await?)
    }

    /// Sign a message, returning the base64 signature.
    pub async fn sign_message(&self, params: SignMessageParams) -> Result<MessageSignature> {
        let req = BtcRequest::sign_message(params).map_err(invalid)?;
        parse_signed(&self.submit(req).await?, "signature")
    }
}

/// Parse a `connect` result (JSON `{address, publicKey}`) and check the address belongs to the
/// requested network.
pub fn parse_account(raw: &str, network: BtcNetwork) -> Result<BtcAccount> {
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| SignerError::Invalid(format!("malformed connect result {raw:?}: {e}")))?;
    let field = |key: &str| {
        parsed
            .get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| SignerError::Invalid(format!("connect result missing {key}: {raw}")))
    };
    Ok(BtcAccount {
        address: parse_signed::<UncheckedAddress>(field("address")?, "address")?
            .require_network(network)
            .map_err(invalid)?,
        public_key: parse_signed(field("publicKey")?, "public key")?,
    })
}

/// Parse a `sign_psbt` result (JSON `{psbt, txid?}`) and check it signs the same transaction as
/// `unsigned`: a wallet may only add signatures, so a changed txid means the result is not what
/// was approved.
pub fn parse_signed_psbt(unsigned: &PsbtData, raw: &str) -> Result<SignedPsbt> {
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| SignerError::Invalid(format!("malformed sign_psbt result {raw:?}: {e}")))?;
    let field = |key: &str| parsed.get(key).and_then(serde_json::Value::as_str);
    let psbt: PsbtData = parse_signed(
        field("psbt")
            .ok_or_else(|| SignerError::Invalid(format!("sign_psbt result missing psbt: {raw}")))?,
        "psbt",
    )?;
    let (expected, got) = (unsigned.unsigned_txid(), psbt.unsigned_txid());
    if expected != got {
        return Err(SignerError::Invalid(format!(
            "wallet returned a PSBT for a different transaction: expected txid {expected}, got {got}"
        )));
    }
    let txid = field("txid")
        .map(|t| parse_signed::<Txid>(t, "txid"))
        .transpose()?;
    if let Some(txid) = txid
        && txid != expected
    {
        return Err(SignerError::Invalid(format!(
            "wallet broadcast txid {txid}, but the PSBT's txid is {expected}"
        )));
    }
    Ok(SignedPsbt { psbt, txid })
}

fn invalid(e: impl std::fmt::Display) -> SignerError {
    SignerError::Invalid(e.to_string())
}

/// Parse a wallet-returned string into a domain type, mapping failures to an error.
pub(crate) fn parse_signed<T: std::str::FromStr>(raw: &str, what: &str) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    raw.parse::<T>()
        .map_err(|e| SignerError::Invalid(format!("wallet returned invalid {what} {raw:?}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::tests::PSBT_HEX;

    fn unsigned() -> PsbtData {
        PSBT_HEX.parse().unwrap()
    }

    #[test]
    fn signed_psbt_for_the_same_tx_is_accepted() {
        let txid = unsigned().unsigned_txid();
        let raw = serde_json::json!({ "psbt": PSBT_HEX, "txid": txid.to_string() }).to_string();
        let signed = parse_signed_psbt(&unsigned(), &raw).unwrap();
        assert_eq!(signed.txid, Some(txid));
        let no_txid = serde_json::json!({ "psbt": PSBT_HEX }).to_string();
        assert!(
            parse_signed_psbt(&unsigned(), &no_txid)
                .unwrap()
                .txid
                .is_none()
        );
    }

    #[test]
    fn signed_psbt_for_a_different_tx_is_rejected() {
        let mut other = unsigned().as_psbt().clone();
        other.unsigned_tx.output[0].value = bitcoin::Amount::from_sat(1);
        let raw = serde_json::json!({ "psbt": other.serialize_hex() }).to_string();
        let err = parse_signed_psbt(&unsigned(), &raw).unwrap_err();
        assert!(err.to_string().contains("different transaction"), "{err}");
    }

    #[test]
    fn broadcast_txid_must_match_the_psbt() {
        let wrong = "0000000000000000000000000000000000000000000000000000000000000001";
        let raw = serde_json::json!({ "psbt": PSBT_HEX, "txid": wrong }).to_string();
        assert!(parse_signed_psbt(&unsigned(), &raw).is_err());
    }

    #[test]
    fn connected_account_must_match_the_network_and_carry_a_key() {
        let tb = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
        let key = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        let raw = serde_json::json!({ "address": tb, "publicKey": key }).to_string();
        let account = parse_account(&raw, BtcNetwork::Signet).unwrap();
        assert_eq!(account.address.to_string(), tb);
        assert_eq!(account.public_key.to_string(), key);
        assert!(parse_account(&raw, BtcNetwork::Mainnet).is_err());
        assert!(
            parse_account(tb, BtcNetwork::Signet).is_err(),
            "bare address"
        );
        let no_key = serde_json::json!({ "address": tb }).to_string();
        assert!(parse_account(&no_key, BtcNetwork::Signet).is_err());
    }
}
