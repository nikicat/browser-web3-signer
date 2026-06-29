//! TRON browser wallet signer.
//!
//! Wraps [`browser_web3_signer_core::Engine`] with TRON request types, the embedded approval UI,
//! and typed operations: connect, send TRX, trigger/deploy contract, message + TIP-712 signing,
//! plus read-only TRX and TRC-20 balance queries via TronGrid HTTP. Signing and transaction
//! building happen browser-side in TronLink.

pub mod config;
pub mod domain;
pub mod signer;
pub mod types;

pub use browser_web3_signer_core::{HexData, Signature, TxHash};
pub use config::{NETWORKS, NetworkConfig, default_network, full_host, network_config, port};
pub use domain::{
    Decimals, EnergyLimit, Percentage, Sun, Symbol, TokenAmount, TronAddress, TronNetwork,
};
pub use signer::{
    BalanceResult, DeployResult, TokenBalanceResult, TronSigner, WEB_UI, parse_deploy_result,
};
pub use types::{
    DeployContractParams, SendTransactionParams, TriggerContractParams, TronRequest, TypedData,
};
