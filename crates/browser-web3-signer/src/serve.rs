//! `serve` — the long-running control-API mode (the "managed bridge subprocess" from the
//! roadmap). A language binding spawns this, reads the bound port from stdout, and drives the
//! wallet over HTTP; the process holds the bridge on a stable port for its lifetime so the wallet
//! skips the reconnect prompt across calls.
//!
//! It mounts a control API onto the core bridge via [`Engine::start_with`] (the same extension
//! point the e2e harness uses):
//! - `POST /api/v1/request` — body is a request in the wire shape `{type, ...}` (parsed by the
//!   chain's `from_json`). Opens the browser for approval, blocks until the wallet responds, and
//!   returns `{ success, result }` or `{ success: false, error, code? }`.
//! - `GET  /api/v1/health`  — `{ status, pendingRequests }`.
//!
//! Generic over the chain's request type `R`, so EVM and TRON share one implementation. The
//! approval page (`/connect` vs `/sign`) comes from the request itself, so the handler stays
//! chain-agnostic and never inspects the wire `type`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use browser_web3_signer_core::{BindPort, BrowserChoice, Engine, Request, Shared, SignerError};
use serde_json::{Value, json};

use crate::output;

/// State shared by the control-API handlers.
struct ControlState<R: Request> {
    engine: Shared<Engine<R>>,
}

// Hand-rolled `Clone` (derive would demand `R: Clone`, which the wrapper doesn't need — the
// engine is behind `Shared`).
impl<R: Request> Clone for ControlState<R> {
    fn clone(&self) -> Self {
        Self {
            engine: self.engine.share(),
        }
    }
}

/// `POST /api/v1/request` — create the request, open the browser, block until the wallet responds.
async fn handle_request<R: Request>(
    State(state): State<ControlState<R>>,
    Json(body): Json<Value>,
) -> Response {
    let req = match R::from_json(&body) {
        Ok(req) => req,
        Err(reason) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": reason }))).into_response();
        }
    };

    // submit = prepare + open browser + await the wallet's response. The request decides its own
    // approval page via `Request::url_kind`, so nothing here is chain-specific.
    match state.engine.submit(req).await {
        Ok(result) => Json(json!({ "success": true, "result": result })).into_response(),
        Err(err) => signer_error_response(&err),
    }
}

/// `GET /api/v1/health` — liveness plus the current pending count.
async fn handle_health<R: Request>(State(state): State<ControlState<R>>) -> Response {
    Json(json!({ "status": "ok", "pendingRequests": state.engine.store().len() })).into_response()
}

/// Map a [`SignerError`] to a JSON error body + status. A wallet rejection / timeout / cancel is a
/// `409` (the request was understood but not fulfilled); anything else is a `500`.
fn signer_error_response(err: &SignerError) -> Response {
    let status = match err {
        SignerError::Rejected { .. } | SignerError::Timeout(_) | SignerError::Cancelled(_) => {
            StatusCode::CONFLICT
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let mut body = json!({ "success": false, "error": err.to_string() });
    if let Some(code) = err.code() {
        body["code"] = json!(code);
    }
    (status, Json(body)).into_response()
}

/// Build the `/api/v1` control routes mounted onto the core bridge.
fn control_routes<R: Request>(state: ControlState<R>) -> Router {
    Router::new()
        .route("/api/v1/request", post(handle_request::<R>))
        .route("/api/v1/health", get(handle_health::<R>))
        .with_state(state)
}

/// Run the control API to completion: start the bridge with the control routes merged in, print
/// the bound port to stdout (for the spawning binding), and block until the process is killed.
///
/// `web_ui` is the chain's embedded approval HTML; requests are parsed via [`Request::from_json`].
pub(crate) async fn run<R: Request>(
    web_ui: &'static str,
    bind: BindPort,
    browser: BrowserChoice,
) -> anyhow::Result<()> {
    let engine = Shared::new(Engine::<R>::new(web_ui, bind, browser));
    let state = ControlState {
        engine: engine.share(),
    };

    let port = engine
        .start_with(Some(control_routes(state)))
        .await
        .map_err(|e| anyhow::anyhow!("failed to start control bridge: {e}"))?;

    // The spawning binding reads this first stdout line to learn where to send control requests.
    println!("{port}");
    output::progress(format!("control API listening on http://127.0.0.1:{port}"));

    // Hold the bridge open for the process lifetime; the binding kills us when done.
    std::future::pending::<()>().await;
    Ok(())
}
