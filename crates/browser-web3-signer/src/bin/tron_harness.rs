//! TRON e2e test harness: runs the TRON bridge with the shared test-only routes (`/api/test/*`)
//! that the Playwright suite drives. Feature-gated behind `e2e`; never shipped in production.
//!
//! All the plumbing lives in [`common::harness`]; request-building is `TronRequest::from_json`
//! (shared with the `serve` control API). See `tests/e2e-browser/README.md` for the lifecycle.

#[path = "common/harness.rs"]
mod harness;

use browser_web3_signer_tron::{TronRequest, WEB_UI};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    harness::run::<TronRequest>(WEB_UI).await
}
