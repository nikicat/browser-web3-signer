//! The chain-agnostic signing engine: owns the [`PendingStore`] and the lazily-started HTTP
//! bridge, and turns a request into an approval URL plus a future for the signed result.
//!
//! Chain crates wrap an [`Engine`] with typed methods (see `EvmSigner`).

use std::pin::Pin;

use tokio::net::TcpListener;
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use uuid::Uuid;

use crate::browser::{self, BrowserChoice, UrlKind};
use crate::config::{BindPort, Port};
use crate::errors::{Result, SignerError};
use crate::http::build_router;
use crate::pending_store::{PendingStore, REQUEST_TIMEOUT};
use crate::shared::Shared;
use crate::types::{Request, RequestResult};

/// A future resolving to the signed result string (address / tx hash / signature).
pub type ResultFuture = Pin<Box<dyn Future<Output = Result<String>> + Send>>;

/// A registered request: its id, the approval URL to open, and a future for the result.
pub struct Prepared {
    /// The request id.
    pub id: Uuid,
    /// The approval URL the browser should open.
    pub url: url::Url,
    /// Resolves when the browser posts a result, or errors on rejection/timeout.
    pub result: ResultFuture,
}

struct ServerState {
    port: Port,
    shutdown: Option<oneshot::Sender<()>>,
    handle: JoinHandle<()>,
}

/// The signing engine for a single chain's request type `R`.
pub struct Engine<R: Request> {
    store: Shared<PendingStore<R>>,
    index_html: &'static str,
    bind: BindPort,
    browser: BrowserChoice,
    server: Mutex<Option<ServerState>>,
}

impl<R: Request> Engine<R> {
    /// Create an engine that will serve `index_html` and bind according to `bind` on first use.
    pub fn new(index_html: &'static str, bind: BindPort, browser: BrowserChoice) -> Self {
        Self {
            store: Shared::new(PendingStore::new()),
            index_html,
            bind,
            browser,
            server: Mutex::new(None),
        }
    }

    /// The shared pending store (used by the daemon to add extra routes).
    pub fn store(&self) -> Shared<PendingStore<R>> {
        self.store.share()
    }

    /// Start the HTTP bridge if it isn't already running; returns the bound port. Idempotent.
    ///
    /// For [`BindPort::Preferred`], binds the preferred port so the browser origin stays stable
    /// across one-shot invocations (letting a wallet skip the reconnect prompt). If that port is
    /// already in use (another one-shot command, or the daemon), it falls back to an ephemeral
    /// port rather than failing — so concurrent commands never collide.
    pub async fn start(&self) -> Result<Port> {
        let mut guard = self.server.lock().await;
        if let Some(state) = guard.as_ref() {
            return Ok(state.port);
        }

        let (listener, port) = bind_listener(self.bind).await?;

        let app = build_router(self.store.share(), self.index_html);
        let (tx, rx) = oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            let server = axum::serve(listener, app).with_graceful_shutdown(async move {
                drop(rx.await);
            });
            if let Err(e) = server.await {
                tracing::error!("http bridge error: {e}");
            }
        });

        *guard = Some(ServerState {
            port,
            shutdown: Some(tx),
            handle,
        });
        Ok(port)
    }

    /// Register a request and build its approval URL, without opening a browser. The returned
    /// future resolves with the signed result. Starts the bridge if needed.
    pub async fn prepare(&self, request: R, kind: UrlKind) -> Result<Prepared> {
        let port = self.start().await?;
        let id = request.id();
        let rx = self.store.create(request);
        let url = browser::build_url(port, id, kind);

        let store = self.store.share();
        let result: ResultFuture = Box::pin(async move {
            let outcome = match timeout(REQUEST_TIMEOUT, rx).await {
                Ok(Ok(result)) => map_result(result),
                Ok(Err(_)) => Err(SignerError::Cancelled(id.to_string())),
                Err(_) => Err(SignerError::Timeout(REQUEST_TIMEOUT.as_secs())),
            };
            // Ensure a timed-out / cancelled entry is removed so the bridge stops serving it.
            if outcome.is_err() {
                store.cancel(id);
            }
            outcome
        });

        Ok(Prepared { id, url, result })
    }

    /// Open a URL according to the engine's configured [`BrowserChoice`].
    pub fn open(&self, url: &url::Url) {
        browser::open(url, &self.browser);
    }

    /// Register a request, open the browser, and await the signed result. The library/daemon
    /// path; the CLI uses [`Engine::prepare`] so it can print the URL before opening.
    pub async fn submit(&self, request: R, kind: UrlKind) -> Result<String> {
        let prepared = self.prepare(request, kind).await?;
        self.open(&prepared.url);
        prepared.result.await
    }

    /// Stop the HTTP bridge if running.
    pub async fn shutdown(&self) {
        let state = self.server.lock().await.take();
        if let Some(mut state) = state {
            if let Some(tx) = state.shutdown.take() {
                tx.send(()).ok();
            }
            drop(state.handle.await);
        }
    }
}

/// Bind the bridge's TCP listener per [`BindPort`], returning the listener and the actual port.
async fn bind_listener(bind: BindPort) -> Result<(TcpListener, Port)> {
    match bind {
        BindPort::Ephemeral => bind_ephemeral().await,
        BindPort::Preferred(preferred) => {
            match TcpListener::bind(("127.0.0.1", preferred.get())).await {
                Ok(listener) => Ok((listener, preferred)),
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                    tracing::info!(
                        "preferred port {preferred} in use; falling back to an ephemeral port"
                    );
                    bind_ephemeral().await
                }
                Err(e) => Err(SignerError::Http(format!(
                    "bind 127.0.0.1:{preferred}: {e}"
                ))),
            }
        }
    }
}

/// Bind an OS-assigned ephemeral port on localhost.
async fn bind_ephemeral() -> Result<(TcpListener, Port)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| SignerError::Http(format!("bind ephemeral port: {e}")))?;
    let raw = listener
        .local_addr()
        .map_err(|e| SignerError::Http(e.to_string()))?
        .port();
    let port =
        Port::try_new(raw).ok_or_else(|| SignerError::Http("OS assigned port 0".to_owned()))?;
    Ok((listener, port))
}

/// Map a browser-delivered [`RequestResult`] into the signed string or a typed error.
fn map_result(result: RequestResult) -> Result<String> {
    match result {
        RequestResult::Success { result: value, .. } => Ok(value),
        RequestResult::Error { error, code, .. } => Err(SignerError::Rejected {
            message: error,
            code,
        }),
    }
}
