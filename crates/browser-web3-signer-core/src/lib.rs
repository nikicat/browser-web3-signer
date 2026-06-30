//! Chain-agnostic engine for browser-based wallet signing.
//!
//! A program registers a signing [`Request`](types::Request); the engine opens a local browser
//! page where the user approves it in their own wallet (MetaMask, Rabby, TronLink, …). The
//! private key never leaves the browser. The bridge binds `127.0.0.1` only.
//!
//! Chain-specific crates (`browser-web3-signer-evm`, `browser-web3-signer-tron`) provide the
//! request types, the embedded UI, and typed signer methods on top of [`engine::Engine`].

pub mod browser;
pub mod bytes;
pub mod config;
pub mod engine;
pub mod errors;
pub mod http;
pub mod pending_store;
pub mod shared;
pub mod types;

pub use browser::{BrowserChoice, UrlKind};
pub use bytes::{HexData, Signature, TxHash};
pub use config::{BindPort, DEFAULT_PORT, Port, port_from_env};
pub use engine::{Engine, Prepared, ResultFuture};
pub use errors::{Result, SignerError, code};
pub use http::build_router_with;
pub use pending_store::{PendingStore, REQUEST_TIMEOUT, generate_request_id};
pub use shared::Shared;
pub use types::{CompleteApiRequest, PendingApiResponse, Request, RequestMeta, RequestResult};

/// Re-exported so downstream crates share one `Url` type for approval URLs.
pub use url::Url;
