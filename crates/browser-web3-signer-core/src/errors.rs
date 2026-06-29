//! Error types for the signing engine, including discriminating codes the browser UI can
//! attach to a rejection so consumers react programmatically (ported from `errors.ts`).

use thiserror::Error;

/// Discriminating code attached to a rejected request.
pub mod code {
    /// The connected wallet account differed from the address the caller required.
    pub const WRONG_WALLET_ADDRESS: &str = "WRONG_WALLET_ADDRESS";
}

/// Errors surfaced by the engine and chain signers.
#[derive(Debug, Error)]
pub enum SignerError {
    /// The user/browser rejected the request, or the wallet returned an error.
    /// `code` carries the discriminating code from the browser when present.
    #[error("{message}")]
    Rejected {
        /// Human-readable reason.
        message: String,
        /// Discriminating code (see [`code`]), if any.
        code: Option<String>,
    },

    /// The request timed out waiting for browser approval.
    #[error("request timed out after {0} seconds")]
    Timeout(u64),

    /// The request id was cancelled or never delivered a result.
    #[error("request cancelled: {0}")]
    Cancelled(String),

    /// The local HTTP bridge failed to start or serve.
    #[error("http server error: {0}")]
    Http(String),

    /// A read-only RPC / upstream call failed.
    #[error("rpc error: {0}")]
    Rpc(String),

    /// Invalid input supplied by the caller.
    #[error("invalid input: {0}")]
    Invalid(String),
}

impl SignerError {
    /// True if this error carries the `WRONG_WALLET_ADDRESS` code anywhere it applies.
    pub fn is_wrong_wallet_address(&self) -> bool {
        matches!(self, SignerError::Rejected { code: Some(c), .. } if c == code::WRONG_WALLET_ADDRESS)
    }

    /// The discriminating code, if any.
    pub fn code(&self) -> Option<&str> {
        match self {
            SignerError::Rejected { code, .. } => code.as_deref(),
            _ => None,
        }
    }
}

/// Convenience alias.
pub type Result<T> = std::result::Result<T, SignerError>;
