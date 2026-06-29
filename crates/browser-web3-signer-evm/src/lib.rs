//! EVM browser wallet signer.
//!
//! Wraps [`browser_web3_signer_core::Engine`] with EVM request types, the embedded approval UI,
//! and typed operations: connect, send transaction, `personal_sign`, EIP-712 typed-data signing,
//! plus read-only native and ERC-20 balance queries via `alloy`.

pub mod config;
pub mod domain;
pub mod signer;
pub mod types;

pub use config::{CHAINS, ChainConfig, DEFAULT_CHAIN_ID, chain_config, default_chain_id, port};
pub use domain::{
    Address, CallData, ChainId, Decimals, Signature, Symbol, TokenAmount, TxHash, Wei,
};
pub use signer::{BalanceResult, EvmSigner, TokenBalanceResult, WEB_UI};
pub use types::{EvmRequest, SendTransactionParams, TypedData};
