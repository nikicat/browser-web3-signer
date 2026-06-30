//! Shared plumbing for the chain-specific e2e harnesses (`evm_harness`, `tron_harness`).
//!
//! Both harnesses run the real bridge for their chain and mount the same test-only routes
//! (`/api/test/*`) the Playwright suite drives. Everything except request-building is identical
//! across chains, so it lives here, generic over the chain's [`Request`] type. Each binary
//! supplies a `build_request` closure that maps the test JSON into its request enum.
//!
//! This module is included via `#[path]` from each `*_harness.rs` rather than compiled as its own
//! binary (files directly under `src/bin/` become binaries; subdirectories do not).
//!
//! See `tests/e2e-browser/README.md` for the request lifecycle and the result-cache rationale.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use browser_web3_signer_core::{BindPort, BrowserChoice, Engine, Request, Shared, SignerError};
use serde_json::Value;
use uuid::Uuid;

/// Harness state: the chain engine and a peekable results cache.
struct HarnessState<R: Request> {
    /// The chain bridge engine (owns the store).
    engine: Shared<Engine<R>>,
    /// Completed outcomes, cached so `/api/test/result/:id` can peek without consuming.
    results: Shared<Mutex<HashMap<Uuid, Value>>>,
}

// Manual `Clone` so the `axum` state can be cloned per-request without requiring `R: Clone`
// on the wrapper (everything inside is behind `Shared`).
impl<R: Request> Clone for HarnessState<R> {
    fn clone(&self) -> Self {
        Self {
            engine: self.engine.share(),
            results: self.results.share(),
        }
    }
}

/// Outcome inserted into the results cache: `{success,result}` or `{success:false,error}`.
///
/// `result` is the engine's opaque transport string, embedded verbatim — the chain layer (and the
/// JS test) interpret it per request type. It is usually a scalar (address / tx hash / signature)
/// but is sometimes a JSON-encoded object (e.g. TRON `deploy_contract` posts `{txHash,
/// contractAddress}`, which the spec `JSON.parse`s). Do not parse or re-type it here.
fn as_outcome(res: Result<String, SignerError>) -> Value {
    match res {
        Ok(v) => serde_json::json!({ "success": true, "result": v }),
        Err(e) => serde_json::json!({ "success": false, "error": e.to_string() }),
    }
}

/// `POST /api/test/create-request` — create a pending request and return its id.
async fn create_request<R: Request>(
    State(state): State<HarnessState<R>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let req = R::from_json(&body).map_err(|_e| StatusCode::BAD_REQUEST)?;

    let prepared = state
        .engine
        .prepare(req)
        .await
        .map_err(|_e| StatusCode::INTERNAL_SERVER_ERROR)?;

    let id = prepared.id;
    let results = state.results.share();

    // Await the oneshot off-thread and cache the outcome; `result` polls the cache.
    tokio::spawn(async move {
        let outcome = as_outcome(prepared.result.await);
        results.lock().unwrap().insert(id, outcome);
    });

    Ok(Json(serde_json::json!({ "id": id })))
}

/// `GET /api/test/result/:id` — peek at a completed outcome, or report pending/unknown.
async fn test_result<R: Request>(
    State(state): State<HarnessState<R>>,
    Path(id): Path<Uuid>,
) -> Json<Value> {
    if let Some(o) = state.results.lock().unwrap().get(&id) {
        return Json(o.clone());
    }
    if state.engine.store().has(id) {
        return Json(serde_json::json!({ "pending": true }));
    }
    Json(serde_json::json!(null))
}

/// Build the test-only routes mounted onto the bridge via `Engine::start_with`.
fn build_extra_routes<R: Request>(state: HarnessState<R>) -> Router {
    Router::new()
        .route("/api/test/create-request", post(create_request::<R>))
        .route("/api/test/result/:id", get(test_result::<R>))
        .with_state(state)
}

/// Run a chain harness to completion: start the bridge with the test routes merged in, print the
/// bound port to stdout (for the Node fixture), and block forever until the process is killed.
///
/// `web_ui` is the chain's embedded approval HTML; requests are parsed via [`Request::from_json`].
pub(crate) async fn run<R: Request>(web_ui: &'static str) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .as_deref()
                .unwrap_or("browser_web3_signer=info"),
        )
        .init();

    // Bind ephemeral, never open a browser; the test fixture drives everything.
    let engine = Shared::new(Engine::<R>::new(
        web_ui,
        BindPort::Ephemeral,
        BrowserChoice::Print,
    ));
    let state = HarnessState {
        engine: engine.share(),
        results: Shared::new(Mutex::new(HashMap::new())),
    };

    let extra = build_extra_routes(state);
    let port = engine
        .start_with(Some(extra))
        .await
        .map_err(|e| anyhow::anyhow!("failed to start engine: {e}"))?;

    // The Node fixture reads this line to know where to point the browser.
    println!("{port}");

    std::future::pending::<()>().await;
    Ok(())
}
