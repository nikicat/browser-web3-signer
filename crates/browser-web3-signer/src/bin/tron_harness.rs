//! TRON e2e test harness: runs the TRON bridge with the shared test-only routes (`/api/test/*`)
//! that the Playwright suite drives. Feature-gated behind `e2e`; never shipped in production.
//!
//! All the plumbing lives in [`common::harness`]; this binary only maps the test JSON into a
//! [`TronRequest`]. See `tests/e2e-browser/README.md` for the request lifecycle.

#[path = "common/harness.rs"]
mod harness;

use browser_web3_signer_tron::{
    DeployContractParams, HexData, SendTransactionParams, Sun, TriggerContractParams, TronAddress,
    TronNetwork, TronRequest, TypedData, WEB_UI,
};
use serde_json::Value;

/// Build a [`TronRequest`] from the JSON body the test harness POSTs (mirrors the reference
/// `createTestRequest`: the caller picks `type` and the fields for that variant).
fn build_request(body: &Value) -> Result<TronRequest, String> {
    let typ = body
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or("missing 'type' field")?;

    let network = body
        .get("network")
        .and_then(|v| v.as_str())
        .map(str::parse::<TronNetwork>)
        .transpose()
        .map_err(|e| e.to_string())?;

    match typ {
        "connect" => Ok(TronRequest::connect(
            network,
            optional_address(body, "address")?,
        )),
        "send_transaction" => Ok(TronRequest::send_transaction(SendTransactionParams {
            to: required_address(body, "to")?,
            from: None,
            amount: required_sun(body, "amount")?,
            data: None,
            network,
        })),
        "trigger_contract" => Ok(TronRequest::trigger_contract(TriggerContractParams {
            contract_address: required_address(body, "contractAddress")?,
            from: None,
            function_selector: body
                .get("functionSelector")
                .and_then(|v| v.as_str())
                .ok_or("missing 'functionSelector' for trigger_contract")?
                .to_owned(),
            parameters: body.get("parameters").cloned(),
            fee_limit: optional_sun(body, "feeLimit")?,
            call_value: optional_sun(body, "callValue")?,
            network,
        })),
        "deploy_contract" => Ok(TronRequest::deploy_contract(DeployContractParams {
            abi: body
                .get("abi")
                .cloned()
                .ok_or("missing 'abi' for deploy_contract")?,
            bytecode: body
                .get("bytecode")
                .and_then(|v| v.as_str())
                .ok_or("missing 'bytecode' for deploy_contract")?
                // `HexData`'s parse error is already a `String`.
                .parse::<HexData>()?,
            contract_name: body
                .get("contractName")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            parameters: body.get("parameters").cloned(),
            from: None,
            fee_limit: optional_sun(body, "feeLimit")?,
            call_value: optional_sun(body, "callValue")?,
            origin_energy_limit: None,
            user_fee_percentage: None,
            network,
        })),
        "sign_message" => Ok(TronRequest::sign_message(
            body.get("message")
                .and_then(|v| v.as_str())
                .ok_or("missing 'message' for sign_message")?
                .to_owned(),
            optional_address(body, "address")?,
            network,
        )),
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
            Ok(TronRequest::sign_typed_data(
                typed_data,
                optional_address(body, "address")?,
                network,
            ))
        }
        other => Err(format!("unknown request type: {other}")),
    }
}

/// Parse a required Base58 address field.
fn required_address(body: &Value, key: &str) -> Result<TronAddress, String> {
    body.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing '{key}'"))?
        .parse::<TronAddress>()
        .map_err(|e| e.to_string())
}

/// Parse an optional Base58 address field, surfacing a parse failure as a reason string.
fn optional_address(body: &Value, key: &str) -> Result<Option<TronAddress>, String> {
    body.get(key)
        .and_then(|v| v.as_str())
        .map(str::parse::<TronAddress>)
        .transpose()
        .map_err(|e| e.to_string())
}

/// Parse a required SUN amount field.
fn required_sun(body: &Value, key: &str) -> Result<Sun, String> {
    body.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing '{key}'"))?
        .parse::<Sun>()
        .map_err(|e| e.to_string())
}

/// Parse an optional SUN amount field.
fn optional_sun(body: &Value, key: &str) -> Result<Option<Sun>, String> {
    body.get(key)
        .and_then(|v| v.as_str())
        .map(str::parse::<Sun>)
        .transpose()
        .map_err(|e| e.to_string())
}

fn empty_object() -> Value {
    serde_json::json!({})
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    harness::run::<TronRequest>(WEB_UI, build_request).await
}
