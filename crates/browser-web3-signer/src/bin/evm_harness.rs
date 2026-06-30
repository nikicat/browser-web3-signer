//! EVM e2e test harness: runs the EVM bridge with the shared test-only routes (`/api/test/*`)
//! that the Playwright suite drives. Feature-gated behind `e2e`; never shipped in production.
//!
//! All the plumbing lives in [`common::harness`]; request-building is `EvmRequest::from_json`
//! (shared with the `serve` control API). See `tests/e2e-browser/README.md` for the lifecycle.

#[path = "common/harness.rs"]
mod harness;

use browser_web3_signer_evm::{EvmRequest, WEB_UI};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    harness::run::<EvmRequest>(WEB_UI).await
}
