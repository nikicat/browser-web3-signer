//! End-to-end test of the HTTP bridge: prepare a request, simulate the browser fetching it
//! and posting a result, and assert the engine's future resolves.

use std::time::Duration;

use browser_web3_signer_core::{BindPort, BrowserChoice, Engine, Request, SignerError, UrlKind};
use serde::Serialize;
use tokio::time;
use uuid::Uuid;

#[derive(Clone, Serialize)]
struct Dummy {
    id: Uuid,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "createdAt")]
    created_at: u64,
    message: String,
}

impl Request for Dummy {
    fn id(&self) -> Uuid {
        self.id
    }
}

const HTML: &str = "<!doctype html><title>test</title>";

fn dummy() -> Dummy {
    Dummy {
        id: Uuid::new_v4(),
        kind: "sign_message".to_owned(),
        created_at: 0,
        message: "hello".to_owned(),
    }
}

#[tokio::test]
async fn round_trip_success() {
    let engine = Engine::<Dummy>::new(HTML, BindPort::Ephemeral, BrowserChoice::Print);
    let port = engine.start().await.unwrap();

    let req = dummy();
    let id = req.id;
    let prepared = engine.prepare(req, UrlKind::Sign).await.unwrap();
    assert_eq!(
        prepared.url.as_str(),
        format!("http://127.0.0.1:{port}/sign/{id}")
    );

    let client = reqwest::Client::new();
    let base = format!("http://127.0.0.1:{port}");

    // Browser fetches the pending request.
    let pending: serde_json::Value = client
        .get(format!("{base}/api/pending/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pending["request"]["type"], "sign_message");
    assert_eq!(pending["request"]["message"], "hello");
    assert_eq!(pending["request"]["id"], id.to_string());

    // Health reflects one pending request.
    let health: serde_json::Value = client
        .get(format!("{base}/api/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["status"], "ok");
    assert_eq!(health["pendingRequests"], 1);

    // Browser posts the signed result.
    let resp = client
        .post(format!("{base}/api/complete/{id}"))
        .json(&serde_json::json!({ "success": true, "result": "0xSIGNATURE" }))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());

    let signature = prepared.result.await.unwrap();
    assert_eq!(signature, "0xSIGNATURE");

    engine.shutdown().await;
}

#[tokio::test]
async fn round_trip_error_with_code() {
    let engine = Engine::<Dummy>::new(HTML, BindPort::Ephemeral, BrowserChoice::Print);
    let port = engine.start().await.unwrap();
    let req = dummy();
    let id = req.id;
    let prepared = engine.prepare(req, UrlKind::Sign).await.unwrap();

    let client = reqwest::Client::new();
    client
        .post(format!("http://127.0.0.1:{port}/api/complete/{id}"))
        .json(&serde_json::json!({
            "success": false,
            "error": "wrong account",
            "code": "WRONG_WALLET_ADDRESS"
        }))
        .send()
        .await
        .unwrap();

    let err = prepared.result.await.unwrap_err();
    assert!(err.is_wrong_wallet_address(), "got: {err:?}");

    engine.shutdown().await;
}

#[tokio::test]
async fn unknown_id_is_404() {
    let engine = Engine::<Dummy>::new(HTML, BindPort::Ephemeral, BrowserChoice::Print);
    let port = engine.start().await.unwrap();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!(
            "http://127.0.0.1:{port}/api/pending/{}",
            Uuid::new_v4()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);

    // Non-API path serves the SPA HTML.
    let html = client
        .get(format!("http://127.0.0.1:{port}/sign/{}", Uuid::new_v4()))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(html.contains("<title>test</title>"));

    engine.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn times_out_and_clears_entry() {
    let engine = Engine::<Dummy>::new(HTML, BindPort::Ephemeral, BrowserChoice::Print);
    engine.start().await.unwrap();
    let req = dummy();
    let prepared = engine.prepare(req, UrlKind::Sign).await.unwrap();

    // Advance virtual time past the 5-minute timeout.
    time::advance(Duration::from_secs(5 * 60 + 1)).await;

    let err = prepared.result.await.unwrap_err();
    assert!(matches!(err, SignerError::Timeout(_)));

    engine.shutdown().await;
}

#[tokio::test]
async fn start_with_merges_extra_routes_over_shared_store() {
    use axum::{Router, routing::get};

    // The shared extension point the daemon (`/api/v1`) and the e2e harness (`/api/test/*`)
    // both build on: extra routes are merged onto the bridge and serve over the same store.
    let engine = Engine::<Dummy>::new(HTML, BindPort::Ephemeral, BrowserChoice::Print);

    // An extra route that reports the live pending count, proving it sees the engine's store.
    let store = engine.store();
    let extra = Router::new().route(
        "/api/test/ping",
        get(move || {
            let store = store.share();
            async move { format!("pending={}", store.len()) }
        }),
    );

    let port = engine.start_with(Some(extra)).await.unwrap();
    let client = reqwest::Client::new();
    let base = format!("http://127.0.0.1:{port}");

    // The merged route responds, and core routes still work alongside it.
    let ping = client
        .get(format!("{base}/api/test/ping"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(ping, "pending=0");

    let prepared = engine.prepare(dummy(), UrlKind::Sign).await.unwrap();
    let ping = client
        .get(format!("{base}/api/test/ping"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(ping, "pending=1", "extra route observes the shared store");

    // Core route is unaffected by the merge.
    let health: serde_json::Value = client
        .get(format!("{base}/api/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["pendingRequests"], 1);

    drop(prepared);
    engine.shutdown().await;
}
