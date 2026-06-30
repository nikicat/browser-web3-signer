//! EVM request types. Their JSON serialization must match what the embedded UI fetches from
//! `GET /api/pending/:id` (ported from `browser-evm-signer/src/types.ts`).
//!
//! The request *kind* is the enum variant itself (serde-tagged via `type`), not a stored
//! string — there is one source of truth for the discriminator.

use browser_web3_signer_core::{Request, RequestMeta, Url, UrlKind};
use serde::Serialize;
use uuid::Uuid;

use crate::domain::{Address, CallData, ChainId, Wei};

/// EIP-712 typed data. The sub-objects are open-ended by the standard, so they stay as JSON
/// inside this named container rather than being forced into a lossy schema.
#[derive(Debug, Clone, Serialize)]
pub struct TypedData {
    /// EIP-712 domain separator.
    pub domain: serde_json::Value,
    /// Type definitions.
    pub types: serde_json::Value,
    /// Primary type name.
    #[serde(rename = "primaryType")]
    pub primary_type: String,
    /// The structured message.
    pub message: serde_json::Value,
}

/// A pending EVM request. The `type` discriminator is derived from the variant.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EvmRequest {
    /// Wallet connection request → `/connect/:id`.
    Connect {
        /// Common fields.
        #[serde(flatten)]
        meta: RequestMeta,
        /// Chain to connect/switch to.
        #[serde(rename = "chainId", skip_serializing_if = "Option::is_none")]
        chain_id: Option<ChainId>,
        /// Expected address; the UI rejects a mismatch.
        #[serde(skip_serializing_if = "Option::is_none")]
        address: Option<Address>,
        /// RPC URL for a custom/non-built-in chain. When the wallet doesn't recognize `chain_id`,
        /// the approval page adds it via `wallet_addEthereumChain` using this URL (e.g. a local
        /// anvil node). Only needed at connect time — once added, later switches just succeed.
        /// A `Url`, so a malformed endpoint fails at the boundary, not in the browser.
        #[serde(rename = "rpcUrl", skip_serializing_if = "Option::is_none")]
        rpc_url: Option<Url>,
        /// Human-readable name for a custom chain added via `wallet_addEthereumChain` (freeform
        /// display text, so a plain `String`).
        #[serde(rename = "chainName", skip_serializing_if = "Option::is_none")]
        chain_name: Option<String>,
    },
    /// Transaction approval request → `/sign/:id`.
    SendTransaction {
        /// Common fields.
        #[serde(flatten)]
        meta: RequestMeta,
        /// Chain id.
        #[serde(rename = "chainId", skip_serializing_if = "Option::is_none")]
        chain_id: Option<ChainId>,
        /// Recipient / contract address.
        to: Address,
        /// Expected `from`; the UI refuses to sign unless the connected wallet matches.
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<Address>,
        /// Value in wei.
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Wei>,
        /// Calldata.
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<CallData>,
        /// Gas limit.
        #[serde(rename = "gasLimit", skip_serializing_if = "Option::is_none")]
        gas_limit: Option<Wei>,
        /// EIP-1559 max fee per gas.
        #[serde(rename = "maxFeePerGas", skip_serializing_if = "Option::is_none")]
        max_fee_per_gas: Option<Wei>,
        /// EIP-1559 max priority fee per gas.
        #[serde(
            rename = "maxPriorityFeePerGas",
            skip_serializing_if = "Option::is_none"
        )]
        max_priority_fee_per_gas: Option<Wei>,
    },
    /// `personal_sign` request → `/sign/:id`.
    SignMessage {
        /// Common fields.
        #[serde(flatten)]
        meta: RequestMeta,
        /// Chain id.
        #[serde(rename = "chainId", skip_serializing_if = "Option::is_none")]
        chain_id: Option<ChainId>,
        /// The message to sign (plain text).
        message: String,
        /// Address to sign with (defaults to the connected account).
        #[serde(skip_serializing_if = "Option::is_none")]
        address: Option<Address>,
    },
    /// EIP-712 typed-data request → `/sign/:id`.
    SignTypedData {
        /// Common fields.
        #[serde(flatten)]
        meta: RequestMeta,
        /// Chain id.
        #[serde(rename = "chainId", skip_serializing_if = "Option::is_none")]
        chain_id: Option<ChainId>,
        /// The typed data to sign.
        #[serde(flatten)]
        typed_data: TypedData,
        /// Address to sign with.
        #[serde(skip_serializing_if = "Option::is_none")]
        address: Option<Address>,
    },
}

impl EvmRequest {
    const fn meta(&self) -> &RequestMeta {
        match self {
            Self::Connect { meta, .. }
            | Self::SendTransaction { meta, .. }
            | Self::SignMessage { meta, .. }
            | Self::SignTypedData { meta, .. } => meta,
        }
    }
}

impl Request for EvmRequest {
    fn id(&self) -> Uuid {
        self.meta().id
    }

    fn url_kind(&self) -> UrlKind {
        match self {
            Self::Connect { .. } => UrlKind::Connect,
            _ => UrlKind::Sign,
        }
    }

    fn from_json(body: &serde_json::Value) -> Result<Self, String> {
        let typ = str_field(body, "type")?;
        let chain_id = body
            .get("chainId")
            .and_then(serde_json::Value::as_u64)
            .map(ChainId);

        match typ {
            "connect" => Ok(Self::connect_with(ConnectParams {
                chain_id,
                address: opt_parsed(body, "address")?,
                rpc_url: opt_parsed(body, "rpcUrl")?,
                chain_name: str_opt(body, "chainName"),
            })),
            "send_transaction" => Ok(Self::send_transaction(SendTransactionParams {
                to: req_parsed(body, "to")?,
                from: opt_parsed(body, "from")?,
                value: opt_parsed(body, "value")?,
                data: opt_parsed(body, "data")?,
                chain_id,
                gas_limit: opt_parsed(body, "gasLimit")?,
                max_fee_per_gas: opt_parsed(body, "maxFeePerGas")?,
                max_priority_fee_per_gas: opt_parsed(body, "maxPriorityFeePerGas")?,
            })),
            "sign_message" => Ok(Self::sign_message(
                str_field(body, "message")?.to_owned(),
                opt_parsed(body, "address")?,
                chain_id,
            )),
            "sign_typed_data" => Ok(Self::sign_typed_data(
                TypedData {
                    domain: json_field(body, "domain"),
                    types: json_field(body, "types"),
                    primary_type: str_field(body, "primaryType")?.to_owned(),
                    message: json_field(body, "message"),
                },
                opt_parsed(body, "address")?,
                chain_id,
            )),
            other => Err(format!("unknown request type: {other}")),
        }
    }
}

/// Parameters for building a `connect` request, including optional custom-chain metadata.
#[derive(Debug, Clone, Default)]
pub struct ConnectParams {
    /// Chain to connect/switch to.
    pub chain_id: Option<ChainId>,
    /// Expected wallet address; the UI rejects a mismatch.
    pub address: Option<Address>,
    /// RPC URL for adding a custom/non-built-in chain (e.g. a local anvil node).
    pub rpc_url: Option<Url>,
    /// Human-readable name for the custom chain.
    pub chain_name: Option<String>,
}

/// Parameters for building a `send_transaction` request (typed; built by the caller/CLI).
#[derive(Debug, Clone)]
pub struct SendTransactionParams {
    /// Recipient / contract address (required).
    pub to: Address,
    /// Expected `from` address.
    pub from: Option<Address>,
    /// Value in wei.
    pub value: Option<Wei>,
    /// Calldata.
    pub data: Option<CallData>,
    /// Chain id.
    pub chain_id: Option<ChainId>,
    /// Gas limit.
    pub gas_limit: Option<Wei>,
    /// EIP-1559 max fee per gas.
    pub max_fee_per_gas: Option<Wei>,
    /// EIP-1559 max priority fee per gas.
    pub max_priority_fee_per_gas: Option<Wei>,
}

impl EvmRequest {
    /// Build a `connect` request with a fresh id (built-in chain, no custom RPC).
    pub fn connect(chain_id: Option<ChainId>, address: Option<Address>) -> Self {
        Self::connect_with(ConnectParams {
            chain_id,
            address,
            rpc_url: None,
            chain_name: None,
        })
    }

    /// Build a `connect` request from full parameters, including optional custom-chain metadata
    /// (`rpc_url` / `chain_name`) used to add a non-built-in chain like a local anvil node.
    pub fn connect_with(params: ConnectParams) -> Self {
        Self::Connect {
            meta: RequestMeta::new(),
            chain_id: params.chain_id,
            address: params.address,
            rpc_url: params.rpc_url,
            chain_name: params.chain_name,
        }
    }

    /// Build a `send_transaction` request.
    pub fn send_transaction(params: SendTransactionParams) -> Self {
        Self::SendTransaction {
            meta: RequestMeta::new(),
            chain_id: params.chain_id,
            to: params.to,
            from: params.from,
            value: params.value,
            data: params.data,
            gas_limit: params.gas_limit,
            max_fee_per_gas: params.max_fee_per_gas,
            max_priority_fee_per_gas: params.max_priority_fee_per_gas,
        }
    }

    /// Build a `sign_message` request.
    pub fn sign_message(
        message: String,
        address: Option<Address>,
        chain_id: Option<ChainId>,
    ) -> Self {
        Self::SignMessage {
            meta: RequestMeta::new(),
            chain_id,
            message,
            address,
        }
    }

    /// Build a `sign_typed_data` request.
    pub fn sign_typed_data(
        typed_data: TypedData,
        address: Option<Address>,
        chain_id: Option<ChainId>,
    ) -> Self {
        Self::SignTypedData {
            meta: RequestMeta::new(),
            chain_id,
            typed_data,
            address,
        }
    }
}

/// Read a required string field, or a "missing/!string" reason.
fn str_field<'a>(body: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    body.get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("missing or non-string field '{key}'"))
}

/// Read an open-ended JSON sub-object, defaulting to `{}` when absent (for EIP-712 parts).
fn json_field(body: &serde_json::Value, key: &str) -> serde_json::Value {
    body.get(key)
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Read an optional freeform string field (no parse/validation), `None` if absent.
fn str_opt(body: &serde_json::Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

/// Parse a required string field into a domain type `T`, mapping failures to a reason.
fn req_parsed<T>(body: &serde_json::Value, key: &str) -> Result<T, String>
where
    T: std::str::FromStr,
    <T as std::str::FromStr>::Err: std::fmt::Display,
{
    str_field(body, key)?
        .parse::<T>()
        .map_err(|e| format!("invalid '{key}': {e}"))
}

/// Parse an optional string field into a domain type `T`; `None` if absent, error if present but
/// unparseable.
fn opt_parsed<T>(body: &serde_json::Value, key: &str) -> Result<Option<T>, String>
where
    T: std::str::FromStr,
    <T as std::str::FromStr>::Err: std::fmt::Display,
{
    body.get(key)
        .and_then(serde_json::Value::as_str)
        .map(|s| s.parse::<T>().map_err(|e| format!("invalid '{key}': {e}")))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_serializes_with_type_and_camelcase() {
        let req = EvmRequest::connect(Some(ChainId(1)), None);
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["type"], "connect");
        assert_eq!(json["chainId"], 1);
        assert!(json.get("id").is_some());
        assert!(json.get("address").is_none());
    }

    #[test]
    fn send_transaction_emits_wire_field_names() {
        let req = EvmRequest::send_transaction(SendTransactionParams {
            to: "0x52908400098527886E0F7030069857D2E4169EE7"
                .parse()
                .unwrap(),
            from: None,
            value: Some("1000".parse().unwrap()),
            data: Some("0xdead".parse().unwrap()),
            chain_id: Some(ChainId(8453)),
            gas_limit: Some("21000".parse().unwrap()),
            max_fee_per_gas: Some("5".parse().unwrap()),
            max_priority_fee_per_gas: None,
        });
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["type"], "send_transaction");
        assert_eq!(json["to"], "0x52908400098527886e0f7030069857d2e4169ee7");
        assert_eq!(json["value"], "1000");
        assert_eq!(json["data"], "0xdead");
        assert_eq!(json["gasLimit"], "21000");
        assert_eq!(json["maxFeePerGas"], "5");
        assert!(json.get("maxPriorityFeePerGas").is_none());
        assert!(json.get("from").is_none());
    }

    #[test]
    fn typed_data_flattens_fields() {
        let req = EvmRequest::sign_typed_data(
            TypedData {
                domain: serde_json::json!({ "name": "X", "chainId": 1 }),
                types: serde_json::json!({ "EIP712Domain": [] }),
                primary_type: "Mail".into(),
                message: serde_json::json!({ "a": 1 }),
            },
            None,
            Some(ChainId(1)),
        );
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["type"], "sign_typed_data");
        assert_eq!(json["primaryType"], "Mail");
        assert_eq!(json["domain"]["name"], "X");
        assert_eq!(json["message"]["a"], 1);
    }

    #[test]
    fn from_json_round_trips_send_transaction() {
        // A request built via the typed API serializes to the wire shape; parsing that wire
        // shape back via `from_json` reproduces the same request (modulo the fresh id).
        let original = EvmRequest::send_transaction(SendTransactionParams {
            to: "0x52908400098527886E0F7030069857D2E4169EE7"
                .parse()
                .unwrap(),
            from: None,
            value: Some("1000".parse().unwrap()),
            data: Some("0xdead".parse().unwrap()),
            chain_id: Some(ChainId(8453)),
            gas_limit: Some("21000".parse().unwrap()),
            max_fee_per_gas: Some("5".parse().unwrap()),
            max_priority_fee_per_gas: None,
        });
        let wire = serde_json::to_value(&original).unwrap();
        let parsed = EvmRequest::from_json(&wire).unwrap();
        let reparsed_wire = serde_json::to_value(&parsed).unwrap();

        // Ids differ (each builder mints a fresh one); compare everything else.
        for v in [&wire, &reparsed_wire] {
            assert_eq!(v["type"], "send_transaction");
        }
        assert_eq!(wire["to"], reparsed_wire["to"]);
        assert_eq!(wire["value"], reparsed_wire["value"]);
        assert_eq!(wire["data"], reparsed_wire["data"]);
        assert_eq!(wire["chainId"], reparsed_wire["chainId"]);
        assert_eq!(wire["gasLimit"], reparsed_wire["gasLimit"]);
        assert_eq!(wire["maxFeePerGas"], reparsed_wire["maxFeePerGas"]);
    }

    #[test]
    fn from_json_rejects_unknown_type_and_bad_field() {
        assert!(EvmRequest::from_json(&serde_json::json!({ "type": "nope" })).is_err());
        // Missing required `to`.
        assert!(EvmRequest::from_json(&serde_json::json!({ "type": "send_transaction" })).is_err());
        // Present but unparseable address.
        let bad = serde_json::json!({ "type": "connect", "address": "0xnothex" });
        assert!(EvmRequest::from_json(&bad).is_err());
    }

    #[test]
    fn from_json_parses_typed_data() {
        let req = EvmRequest::from_json(&serde_json::json!({
            "type": "sign_typed_data",
            "primaryType": "Mail",
            "domain": { "name": "X" },
            "types": { "EIP712Domain": [] },
            "message": { "a": 1 },
            "chainId": 1,
        }))
        .unwrap();
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["primaryType"], "Mail");
        assert_eq!(json["domain"]["name"], "X");
    }
}
