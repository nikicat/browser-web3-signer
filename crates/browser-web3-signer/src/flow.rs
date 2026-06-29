//! Shared one-shot approval flow used by every chain's subcommands: surface the approval URL,
//! open the browser (unless `--print`), await the wallet's response, and (optionally) parse it
//! into a domain type.
//!
//! [`browser_web3_signer_core::Prepared`] is chain-agnostic, so this works for EVM and TRON alike.

use std::fmt::Display;
use std::str::FromStr;

use anyhow::Result;
use browser_web3_signer_core::{Prepared, Url};
use browser_web3_signer_evm::EvmSigner;
use browser_web3_signer_tron::TronSigner;

use crate::OpenMode;
use crate::output;

/// Something that can open an approval URL in the user's browser. Implemented by each chain's
/// signer; passed to the flow helpers so they don't depend on a bare closure.
pub trait ApprovalOpener {
    /// Open `url` according to the signer's configured browser choice.
    fn open_url(&self, url: &Url);
}

impl ApprovalOpener for EvmSigner {
    fn open_url(&self, url: &Url) {
        self.open(url);
    }
}

impl ApprovalOpener for TronSigner {
    fn open_url(&self, url: &Url) {
        self.open(url);
    }
}

/// Surface the URL, open it (unless `--print`), and await the raw wallet response string.
pub async fn await_raw(
    prepared: Prepared,
    open: &OpenMode,
    opener: &dyn ApprovalOpener,
) -> Result<String> {
    output::progress(format!("Approval URL: {}", prepared.url));
    match open {
        OpenMode::PrintOnly => output::progress("(--print) open the URL above to approve"),
        _ => {
            opener.open_url(&prepared.url);
            output::progress("Waiting for approval in your browser…");
        }
    }
    Ok(prepared.result.await?)
}

/// Like [`await_raw`], but parse the response into the expected domain type `T`. The type the
/// caller binds the result to documents what the operation returns.
pub async fn await_signed<T>(
    prepared: Prepared,
    open: &OpenMode,
    opener: &dyn ApprovalOpener,
    what: &str,
) -> Result<T>
where
    T: FromStr,
    <T as FromStr>::Err: Display,
{
    let raw = await_raw(prepared, open, opener).await?;
    raw.parse::<T>()
        .map_err(|e| anyhow::anyhow!("wallet returned an invalid {what}: {e}"))
}
