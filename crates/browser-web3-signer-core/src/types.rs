//! Chain-agnostic request/result types shared by the HTTP bridge and the browser UI.
//!
//! The JSON shapes here must stay byte-compatible with the browser UI and the TypeScript
//! adaptors (ported from `wallet-signer-core/src/types.ts`).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::browser::UrlKind;

/// Trait every chain-specific pending request must satisfy.
///
/// Chain packages model their requests as a serde-tagged enum (see `EvmRequest`,
/// `TronRequest`) that serializes to `{ "id", "type", "createdAt", ...fields }` — the exact
/// shape the in-page router fetches from `GET /api/pending/:id`.
pub trait Request: Serialize + Sized + Clone + Send + Sync + 'static {
    /// The UUID assigned to this request.
    fn id(&self) -> Uuid;

    /// Which page the browser should open for this request (`/connect/:id` vs `/sign/:id`).
    ///
    /// The request variant decides its own page — callers never re-derive this from the wire
    /// `type`, keeping one source of truth for the discriminator.
    fn url_kind(&self) -> UrlKind;

    /// Build a request from a JSON body — the inverse of its wire serialization (`type`
    /// discriminator + fields). Errors (as a human-readable reason) on an unknown `type`, a
    /// missing required field, or a field that fails its domain-type parse.
    ///
    /// One source of truth for the request wire shape, shared by the `serve` control API and the
    /// e2e harness so the two cannot drift.
    fn from_json(body: &serde_json::Value) -> Result<Self, String>;
}

/// Metadata common to every chain request, flattened into its JSON as `{ "id": "<uuid>" }`.
///
/// Chain request enums embed this via `#[serde(flatten)]` so there is one source of truth for
/// per-request fields shared across chains (and a place to grow, e.g. a daemon app label).
#[derive(Debug, Clone, Serialize)]
pub struct RequestMeta {
    /// Request id (UUID).
    pub id: Uuid,
}

impl RequestMeta {
    /// Build metadata with a fresh request id.
    #[must_use]
    pub fn new() -> Self {
        Self { id: Uuid::new_v4() }
    }
}

impl Default for RequestMeta {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of a signing request, mirroring the `RequestResult` discriminated union.
///
/// Serializes to `{ "success": true, "result": "..." }` or
/// `{ "success": false, "error": "...", "code": "..." }`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RequestResult {
    /// Success branch: `result` is an address, tx hash, or signature depending on request type.
    Success {
        /// Always `true`.
        success: SuccessFlag<true>,
        /// Address, tx hash, or signature — interpreted per request type by the caller.
        result: String,
    },
    /// Failure branch.
    Error {
        /// Always `false`.
        success: SuccessFlag<false>,
        /// Human-readable error message.
        error: String,
        /// Discriminating code so consumers can react programmatically (see [`crate::errors`]).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}

impl RequestResult {
    /// Build a success result.
    pub fn success(result: impl Into<String>) -> Self {
        Self::Success {
            success: SuccessFlag,
            result: result.into(),
        }
    }

    /// Build an error result.
    pub fn error(error: impl Into<String>, code: Option<String>) -> Self {
        Self::Error {
            success: SuccessFlag,
            error: error.into(),
            code,
        }
    }
}

/// A zero-size type that serializes to the boolean literal `B`, used to pin the `success`
/// discriminant on each branch of [`RequestResult`] while keeping `#[serde(untagged)]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuccessFlag<const B: bool>;

impl<const B: bool> Serialize for SuccessFlag<B> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(B)
    }
}

impl<'de, const B: bool> Deserialize<'de> for SuccessFlag<B> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let v = bool::deserialize(d)?;
        if v == B {
            Ok(Self)
        } else {
            Err(D::Error::custom(format!("expected success={B}, got {v}")))
        }
    }
}

/// Body shape of `POST /api/complete/:id`, posted by the browser UI when the wallet resolves.
#[derive(Debug, Clone, Deserialize)]
pub struct CompleteApiRequest {
    /// Whether the wallet operation succeeded.
    pub success: bool,
    /// Result string on success.
    #[serde(default)]
    pub result: Option<String>,
    /// Error message on failure.
    #[serde(default)]
    pub error: Option<String>,
    /// Discriminating code paired with `error`.
    #[serde(default)]
    pub code: Option<String>,
}

impl From<CompleteApiRequest> for RequestResult {
    fn from(body: CompleteApiRequest) -> Self {
        if body.success {
            Self::success(body.result.unwrap_or_default())
        } else {
            Self::error(
                body.error.unwrap_or_else(|| "Unknown error".to_owned()),
                body.code,
            )
        }
    }
}

/// Response shape of `GET /api/pending/:id`: `{ "request": <R> }`.
#[derive(Debug, Clone, Serialize)]
pub struct PendingApiResponse<R> {
    /// The pending request awaiting browser approval.
    pub request: R,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_serializes_with_boolean_true() {
        let json = serde_json::to_value(RequestResult::success("0xabc")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "success": true, "result": "0xabc" })
        );
    }

    #[test]
    fn error_serializes_with_code_when_present() {
        let json = serde_json::to_value(RequestResult::error(
            "nope",
            Some("WRONG_WALLET_ADDRESS".into()),
        ))
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "success": false, "error": "nope", "code": "WRONG_WALLET_ADDRESS" })
        );
    }

    #[test]
    fn error_omits_code_when_absent() {
        let json = serde_json::to_value(RequestResult::error("nope", None)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "success": false, "error": "nope" })
        );
    }

    #[test]
    fn complete_body_maps_to_result() {
        let body: CompleteApiRequest =
            serde_json::from_value(serde_json::json!({ "success": true, "result": "0x1" }))
                .unwrap();
        assert_eq!(RequestResult::from(body), RequestResult::success("0x1"));
    }
}
