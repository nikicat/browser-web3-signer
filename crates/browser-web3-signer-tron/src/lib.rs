//! TRON browser wallet signer.
//!
//! Wraps [`browser_web3_signer_core::Engine`] with TRON request types, the embedded approval UI,
//! and typed operations: connect, send TRX, trigger/deploy contract, message + TIP-712 signing.
//! Signing and transaction building happen browser-side in TronLink.

pub mod config;
pub mod domain;
pub mod signer;
pub mod types;

// Core types that appear in this crate's public API, so depending on
// `browser-web3-signer-tron` alone is enough to drive a signer.
pub use browser_web3_signer_core::{
    BindPort, BrowserChoice, Engine, HexData, Prepared, Signature, SignerError, TxHash, Url,
};
pub use config::{NETWORKS, NetworkConfig, default_network, network_config, port};
pub use domain::{
    Decimals, EnergyLimit, Percentage, Sun, Symbol, TokenAmount, TronAddress, TronNetwork,
};
pub use signer::{DeployResult, TronSigner, WEB_UI, parse_deploy_result};
pub use types::{
    DeployContractParams, SendTransactionParams, TriggerContractParams, TronRequest, TypedData,
};
