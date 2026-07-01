//! The localhost HTTP bridge between the engine and the browser approval UI (ported from
//! `http-server.ts`). Binds `127.0.0.1` only.
//!
//! Routes:
//! - `GET  /api/pending/:id`  → `{ "request": <R> }`
//! - `POST /api/complete/:id` → resolves the pending request
//! - `GET  /api/health`       → `{ "status": "ok", "pendingRequests": N }`
//! - `GET  /app-core.js`      → the shared, chain-agnostic UI engine (both pages `<script src>` it)
//! - everything else          → the embedded SPA HTML (in-page router handles `/sign/:id` etc.)

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{Method, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use tower_http::cors::{Any, CorsLayer};
use uuid::Uuid;

use crate::pending_store::PendingStore;
use crate::shared::Shared;
use crate::types::{CompleteApiRequest, PendingApiResponse, Request};

/// The shared, chain-agnostic UI engine, embedded once and served at `/app-core.js`.
///
/// Both the EVM and TRON approval pages load it via `<script src="/app-core.js">` and supply only
/// a thin chain adapter, so the bridge protocol and error contract are defined in exactly one
/// place.
///
/// TODO: author this (and the per-page adapters) in TypeScript for type safety, then either
/// transpile with a Deno runtime that serves the JS from the `.ts` on the fly, or compile it in a
/// build step and embed the emitted `.js`. Kept as hand-written JS for now so `include_str!` works
/// in the Node-less CI build with no extra toolchain.
pub const APP_CORE_JS: &str = include_str!("../../../web/app-core.js");

/// Shared state for the HTTP handlers.
pub struct AppState<R: Request> {
    /// The pending-request store backing this bridge.
    pub store: Shared<PendingStore<R>>,
    /// The embedded SPA served for any non-API GET.
    pub index_html: &'static str,
}

impl<R: Request> Clone for AppState<R> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.share(),
            index_html: self.index_html,
        }
    }
}

/// CORS layer matching the reference: any origin, GET/POST/OPTIONS, Content-Type header.
pub fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
}

/// Build the core router (pending/complete/health + SPA fallback) for a store + embedded UI.
pub fn build_router<R: Request>(
    store: Shared<PendingStore<R>>,
    index_html: &'static str,
) -> Router {
    build_router_with(store, index_html, None)
}

/// Build the bridge router, optionally merging caller-supplied `extra` routes onto it.
///
/// This is the extension point both the planned daemon (its `/api/v1` control API) and the e2e
/// test harness (`/api/test/*`) hook into: they share the same [`PendingStore`] but mount their
/// own routes. `extra` must already carry its own state via [`axum::Router::with_state`]; it is
/// merged after the core routes and the core CORS layer, so a contributor composes its own
/// middleware rather than inheriting the bridge's.
pub fn build_router_with<R: Request>(
    store: Shared<PendingStore<R>>,
    index_html: &'static str,
    extra: Option<Router>,
) -> Router {
    let state = AppState { store, index_html };
    let core = Router::new()
        .route("/api/pending/:id", get(get_pending::<R>))
        .route("/api/complete/:id", post(post_complete::<R>))
        .route("/api/health", get(get_health::<R>))
        .route("/app-core.js", get(serve_app_core))
        .fallback(serve_index::<R>)
        .layer(cors_layer())
        .with_state(state);
    match extra {
        Some(extra) => core.merge(extra),
        None => core,
    }
}

async fn get_pending<R: Request>(
    State(state): State<AppState<R>>,
    Path(id): Path<Uuid>,
) -> Response {
    state.store.get(id).map_or_else(
        || json_error(StatusCode::NOT_FOUND, "Request not found"),
        |request| Json(PendingApiResponse { request }).into_response(),
    )
}

async fn post_complete<R: Request>(
    State(state): State<AppState<R>>,
    Path(id): Path<Uuid>,
    Json(body): Json<CompleteApiRequest>,
) -> Response {
    if !state.store.has(id) {
        return json_error(StatusCode::NOT_FOUND, "Request not found");
    }
    if state.store.complete(id, body.into()) {
        (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
    } else {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to complete request",
        )
    }
}

async fn get_health<R: Request>(State(state): State<AppState<R>>) -> Response {
    Json(serde_json::json!({ "status": "ok", "pendingRequests": state.store.len() }))
        .into_response()
}

async fn serve_app_core() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        APP_CORE_JS,
    )
        .into_response()
}

async fn serve_index<R: Request>(State(state): State<AppState<R>>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Html(state.index_html),
    )
        .into_response()
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}
