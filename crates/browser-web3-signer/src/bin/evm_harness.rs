//! EVM e2e test harness: runs the EVM bridge with the shared test-only routes (`/api/test/*`)
//! that the Playwright suite drives. Feature-gated behind `e2e`; never shipped in production.
//!
//! All the plumbing lives in [`common::harness`]; this binary only maps the test JSON into an
//! [`EvmRequest`]. See `tests/e2e-browser/README.md` for the request lifecycle.

#[path = "common/harness.rs"]
mod harness;

use browser_web3_signer_evm::{
    Address, ChainId, EvmRequest, SendTransactionParams, TypedData, WEB_UI, Wei,
};
use serde_json::Value;

/// Build an [`EvmRequest`] from the JSON body the test harness POSTs (mirrors the reference
/// `createTestRequest`: the caller picks `type` and the fields for that variant).
fn build_request(body: &Value) -> Result<EvmRequest, String> {
    let typ = body
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("missing 'type' field")?;

    let chain_id = body.get("chainId").and_then(Value::as_u64).map(ChainId);

    match typ {
        "connect" => {
            let address = optional_address(body, "address")?;
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
            Ok(EvmRequest::send_transaction(SendTransactionParams {
                to,
                from: None,
                value,
                data: None,
                chain_id,
                gas_limit: None,
                max_fee_per_gas: None,
                max_priority_fee_per_gas: None,
            }))
        }
        "sign_message" => {
            let message = body
                .get("message")
                .and_then(|v| v.as_str())
                .ok_or("missing 'message' for sign_message")?
                .to_owned();
            Ok(EvmRequest::sign_message(
                message,
                optional_address(body, "address")?,
                chain_id,
            ))
        }
        "sign_typed_data" => {
            let typed_data = TypedData {
                domain: body.get("domain").cloned().unwrap_or_else(empty_object),
                types: body.get("types").cloned().unwrap_or_else(empty_object),
                primary_type: body
                    .get("primaryType")
                    .and_then(|v| v.as_str())
                    .ok_or("missing 'primaryType' for sign_typed_data")?
                    .to_owned(),
                message: body.get("message").cloned().unwrap_or_else(empty_object),
            };
            Ok(EvmRequest::sign_typed_data(
                typed_data,
                optional_address(body, "address")?,
                chain_id,
            ))
        }
        other => Err(format!("unknown request type: {other}")),
    }
}

/// Parse an optional Base16 address field, surfacing a parse failure as a reason string.
fn optional_address(body: &Value, key: &str) -> Result<Option<Address>, String> {
    body.get(key)
        .and_then(|v| v.as_str())
        .map(str::parse::<Address>)
        .transpose()
        .map_err(|e| e.to_string())
}

fn empty_object() -> Value {
    serde_json::json!({})
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    harness::run::<EvmRequest>(WEB_UI, build_request).await
}
