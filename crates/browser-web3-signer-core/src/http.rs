//! The localhost HTTP bridge between the engine and the browser approval UI (ported from
//! `http-server.ts`). Binds `127.0.0.1` only.
//!
//! Routes:
//! - `GET  /api/pending/:id`  → `{ "request": <R> }`
//! - `POST /api/complete/:id` → resolves the pending request
//! - `GET  /api/health`       → `{ "status": "ok", "pendingRequests": N }`
//! - everything else          → the embedded SPA HTML (in-page router handles `/sign/:id` etc.)

use std::sync::Arc;

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
use crate::types::{CompleteApiRequest, PendingApiResponse, Request};

/// Shared state for the HTTP handlers.
pub struct AppState<R: Request> {
    /// The pending-request store backing this bridge.
    pub store: Arc<PendingStore<R>>,
    /// The embedded SPA served for any non-API GET.
    pub index_html: &'static str,
}

impl<R: Request> Clone for AppState<R> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
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
pub fn build_router<R: Request>(store: Arc<PendingStore<R>>, index_html: &'static str) -> Router {
    let state = AppState { store, index_html };
    Router::new()
        .route("/api/pending/:id", get(get_pending::<R>))
        .route("/api/complete/:id", post(post_complete::<R>))
        .route("/api/health", get(get_health::<R>))
        .fallback(serve_index::<R>)
        .layer(cors_layer())
        .with_state(state)
}

async fn get_pending<R: Request>(
    State(state): State<AppState<R>>,
    Path(id): Path<Uuid>,
) -> Response {
    match state.store.get(id) {
        Some(request) => Json(PendingApiResponse { request }).into_response(),
        None => json_error(StatusCode::NOT_FOUND, "Request not found"),
    }
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
