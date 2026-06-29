//! Chain-agnostic store of pending signing requests, keyed by UUID (ported from
//! `pending-store.ts`).
//!
//! Each [`PendingStore::create`] registers a request and hands back a receiver that fires when
//! [`PendingStore::complete`] is called (typically from the browser approval UI via the HTTP
//! bridge). Timeout/cancellation is handled by the engine, which drops the entry.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::oneshot;
use uuid::Uuid;

use crate::types::{Request, RequestResult};

/// Default timeout for pending requests (5 minutes).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Generate a fresh request id.
pub fn generate_request_id() -> Uuid {
    Uuid::new_v4()
}

struct Entry<R> {
    request: R,
    tx: oneshot::Sender<RequestResult>,
}

/// In-memory store of pending requests awaiting browser approval.
pub struct PendingStore<R: Request> {
    pending: Mutex<HashMap<Uuid, Entry<R>>>,
}

impl<R: Request> Default for PendingStore<R> {
    fn default() -> Self {
        Self::new()
    }
}

impl<R: Request> PendingStore<R> {
    /// Create an empty store.
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Register a request, returning a receiver that resolves when the request is completed.
    /// Dropping the entry (via [`Self::cancel`] or the receiver being dropped) cancels it.
    pub fn create(&self, request: R) -> oneshot::Receiver<RequestResult> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(request.id(), Entry { request, tx });
        rx
    }

    /// Get a clone of the request for a pending id, or `None` if completed/cancelled.
    pub fn get(&self, id: Uuid) -> Option<R> {
        self.pending
            .lock()
            .unwrap()
            .get(&id)
            .map(|e| e.request.clone())
    }

    /// Resolve a pending request with a result. Returns `false` if the id was unknown.
    pub fn complete(&self, id: Uuid, result: RequestResult) -> bool {
        let entry = self.pending.lock().unwrap().remove(&id);
        match entry {
            Some(entry) => {
                // Receiver may have been dropped (caller gave up); ignore send failure.
                let _ = entry.tx.send(result);
                true
            }
            None => false,
        }
    }

    /// Drop a pending request. The associated receiver resolves to a `RecvError`. Returns
    /// `false` if the id was unknown.
    pub fn cancel(&self, id: Uuid) -> bool {
        self.pending.lock().unwrap().remove(&id).is_some()
    }

    /// True if a request with this id is still pending.
    pub fn has(&self, id: Uuid) -> bool {
        self.pending.lock().unwrap().contains_key(&id)
    }

    /// Snapshot of all pending request ids.
    pub fn pending_ids(&self) -> Vec<Uuid> {
        self.pending.lock().unwrap().keys().copied().collect()
    }

    /// Number of pending requests.
    pub fn len(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    /// True if there are no pending requests.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
