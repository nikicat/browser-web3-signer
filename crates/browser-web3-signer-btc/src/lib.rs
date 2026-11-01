//! Bitcoin browser wallet signer.
//!
//! Wraps [`browser_web3_signer_core::Engine`] with Bitcoin request types, the embedded approval
//! UI, and typed operations: connect, send to an address, sign a PSBT, sign a message. Coin
//! selection and signing happen browser-side in the wallet (Unisat). See
//! `docs/adr/0001-bitcoin-support.md`.

pub mod config;
pub mod domain;
pub mod signer;
pub mod types;

// Core types that appear in this crate's public API, so depending on
// `browser-web3-signer-btc` alone is enough to drive a signer.
pub use bitcoin::Txid;
pub use browser_web3_signer_core::{BindPort, BrowserChoice, Engine, Prepared, SignerError, Url};
pub use config::{block_explorer, default_network, port};
pub use domain::{
    BtcAddress, BtcNetwork, MessageProtocol, MessageSignature, PsbtData, SatPerVb, Sats,
    UncheckedAddress,
};
pub use signer::{BtcSigner, SignedPsbt, WEB_UI, parse_address, parse_signed_psbt};
pub use types::{BtcRequest, SendTransferParams, SignMessageParams, SignPsbtParams};
