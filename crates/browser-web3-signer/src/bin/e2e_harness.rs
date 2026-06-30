//! E2E test harness: runs the EVM bridge with test-only routes (`/api/test/*`) that the
//! Playwright suite drives. Feature-gated behind `e2e`; never shipped in production.
//!
//! The harness owns an [`browser_web3_signer_evm::EvmSigner`], serves the real embedded HTML,
//! and extends the bridge with two test endpoints that mirror the TypeScript reference:
//!
//! - `POST /api/test/create-request` — create a pending request of a given type, return `{id}`.
//! - `GET  /api/test/result/:id`   — peek at the outcome without consuming it.
//!
//! The latter bridges the oneshot result (consumed on read) to a testable peekable state by
//! spawning a task that awaits the future and stashes the outcome in a side map.
//!
//! The harness binds an ephemeral port and prints it to stdout; the Node test fixture reads
//! this to know where to point the browser.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use browser_web3_signer_core::{BindPort, BrowserChoice, Shared};
use browser_web3_signer_evm::{
    Address, ChainId, EvmRequest, EvmSigner, SendTransactionParams, TypedData, Wei,
};
use serde_json::Value;
use uuid::Uuid;

/// Harness state: a shared signer and a results cache for peekable outcomes.
#[derive(Clone)]
struct HarnessState {
    /// The EVM signer (owns the engine + store).
    signer: Shared<EvmSigner>,
    /// Cached outcomes for test peeking; completed entries live here, not in the engine.
    results: Shared<Mutex<HashMap<Uuid, Value>>>,
}

/// Outcome inserted into the results cache: `{success,result}` or `{success:false,error}`.
fn as_outcome(res: Result<String, browser_web3_signer_core::SignerError>) -> Value {
    match res {
        Ok(v) => serde_json::json!({ "success": true, "result": v }),
        Err(e) => serde_json::json!({ "success": false, "error": e.to_string() }),
    }
}

/// Build an [`EvmRequest`] from the JSON body the test harness POSTs.
///
/// Mirrors the TypeScript `createTestRequest` function: the caller specifies `type` and the
/// fields for that variant; we build the enum and hand it to the engine.
fn build_request(body: &Value) -> Result<EvmRequest, String> {
    let typ = body
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("missing 'type' field")?;

    let chain_id = body.get("chainId").and_then(Value::as_u64).map(ChainId);

    match typ {
        "connect" => {
            let address = body
                .get("address")
                .and_then(|v| v.as_str())
                .map(str::parse::<Address>)
                .transpose()
                .map_err(|e| e.to_string())?;
            Ok(EvmRequest::connect(chain_id, address))
        }
        "send_transaction" => {
            let to = body
                .get("to")
                .and_then(|v| v.as_str())
                .ok_or("missing 'to' for send_transaction")?
                .parse::<Address>()
                .map_err(|e| e.to_string())?;
            let value = body
                .get("value")
                .and_then(|v| v.as_str())
                .map(str::parse::<Wei>)
                .transpose()
                .map_err(|e| e.to_string())?;
            let params = SendTransactionParams {
                to,
                from: None,
                value,
                data: None,
                chain_id,
                gas_limit: None,
                max_fee_per_gas: None,
                max_priority_fee_per_gas: None,
            };
            Ok(EvmRequest::send_transaction(params))
        }
        "sign_message" => {
            let message = body
                .get("message")
                .and_then(|v| v.as_str())
                .ok_or("missing 'message' for sign_message")?
                .to_owned();
            let address = body
                .get("address")
                .and_then(|v| v.as_str())
                .map(str::parse::<Address>)
                .transpose()
                .map_err(|e| e.to_string())?;
            Ok(EvmRequest::sign_message(message, address, chain_id))
        }
        "sign_typed_data" => {
            let domain = body
                .get("domain")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let types = body
                .get("types")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let primary_type = body
                .get("primaryType")
                .and_then(|v| v.as_str())
                .ok_or("missing 'primaryType' for sign_typed_data")?
                .to_owned();
            let message = body
                .get("message")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let address = body
                .get("address")
                .and_then(|v| v.as_str())
                .map(str::parse::<Address>)
                .transpose()
                .map_err(|e| e.to_string())?;
            let typed_data = TypedData {
                domain,
                types,
                primary_type,
                message,
            };
            Ok(EvmRequest::sign_typed_data(typed_data, address, chain_id))
        }
        _ => Err(format!("unknown request type: {typ}")),
    }
}

/// `POST /api/test/create-request` — create a pending request and return its id.
async fn create_request(
    State(state): State<HarnessState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let req = build_request(&body).map_err(|_e| StatusCode::BAD_REQUEST)?;

    let prepared = state
        .signer
        .prepare(req)
        .await
        .map_err(|_e| StatusCode::INTERNAL_SERVER_ERROR)?;

    let id = prepared.id;
    let results = state.results.share();

    // Spawn a task that awaits the oneshot and caches the outcome; the harness polls
    // `/api/test/result/:id` to peek without consuming.
    tokio::spawn(async move {
        let outcome = as_outcome(prepared.result.await);
        results.lock().unwrap().insert(id, outcome);
    });

    Ok(Json(serde_json::json!({ "id": id })))
}

/// `GET /api/test/result/:id` — peek at a completed outcome or report pending/unknown.
async fn test_result(State(state): State<HarnessState>, Path(id): Path<Uuid>) -> Json<Value> {
    // Completed outcomes live in the cache.
    if let Some(o) = state.results.lock().unwrap().get(&id) {
        return Json(o.clone());
    }

    // Still pending in the engine.
    if state.signer.engine().store().has(id) {
        return Json(serde_json::json!({ "pending": true }));
    }

    // Unknown.
    Json(serde_json::json!(null))
}

/// Build the extra routes mounted by the harness.
fn build_extra_routes(state: HarnessState) -> Router {
    Router::new()
        .route("/api/test/create-request", post(create_request))
        .route("/api/test/result/:id", get(test_result))
        .with_state(state)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing (env var configurable).
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .as_deref()
                .unwrap_or("browser_web3_signer=info"),
        )
        .init();

    // Bind ephemeral, never open a browser; the test fixture drives everything.
    let signer = Shared::new(EvmSigner::new(
        BindPort::Ephemeral,
        ChainId(1),
        BrowserChoice::Print,
    ));

    let state = HarnessState {
        signer: signer.share(),
        results: Shared::new(Mutex::new(HashMap::new())),
    };

    let extra = build_extra_routes(state);

    // Start the engine with the extra routes merged in.
    let port = signer
        .engine()
        .start_with(Some(extra))
        .await
        .map_err(|e| anyhow::anyhow!("failed to start engine: {e}"))?;

    // Print just the port so the Node fixture reads it.
    println!("{port}");

    // Run forever; killed by the test fixture.
    std::future::pending().await
}
