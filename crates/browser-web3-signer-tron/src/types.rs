//! TRON request types. JSON serialization must match what the embedded UI fetches from
//! `GET /api/pending/:id` (ported from `browser-tron-signer/src/types.ts`).

use browser_web3_signer_core::{HexData, Request, RequestMeta, UrlKind};
use serde::Serialize;
use uuid::Uuid;

use crate::domain::{EnergyLimit, Percentage, Sun, TronAddress, TronNetwork};

/// TIP-712 typed data (shape mirrors EIP-712). Open-ended sub-objects stay as JSON.
#[derive(Debug, Clone, Serialize)]
pub struct TypedData {
    /// TIP-712 domain separator.
    pub domain: serde_json::Value,
    /// Type definitions.
    pub types: serde_json::Value,
    /// Primary type name.
    #[serde(rename = "primaryType")]
    pub primary_type: String,
    /// The structured message.
    pub message: serde_json::Value,
}

/// A pending TRON request. The `type` discriminator is derived from the variant; fields use
/// camelCase to match the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TronRequest {
    /// Wallet connection → `/connect/:id`.
    Connect {
        #[serde(flatten)]
        meta: RequestMeta,
        #[serde(skip_serializing_if = "Option::is_none")]
        network: Option<TronNetwork>,
        #[serde(skip_serializing_if = "Option::is_none")]
        address: Option<TronAddress>,
    },
    /// Native TRX transfer → `/sign/:id`.
    SendTransaction {
        #[serde(flatten)]
        meta: RequestMeta,
        #[serde(skip_serializing_if = "Option::is_none")]
        network: Option<TronNetwork>,
        /// Recipient address.
        to: TronAddress,
        /// Expected `from`; the UI rejects a mismatch.
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<TronAddress>,
        /// Amount in SUN.
        amount: Sun,
        /// Optional hex-encoded memo.
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<HexData>,
    },
    /// Smart-contract call → `/sign/:id`.
    TriggerContract {
        #[serde(flatten)]
        meta: RequestMeta,
        #[serde(skip_serializing_if = "Option::is_none")]
        network: Option<TronNetwork>,
        /// Contract address.
        #[serde(rename = "contractAddress")]
        contract_address: TronAddress,
        /// Expected `from`; the UI rejects a mismatch.
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<TronAddress>,
        /// Function signature, e.g. `transfer(address,uint256)`.
        #[serde(rename = "functionSelector")]
        function_selector: String,
        /// ABI parameter list (`[{type, value}, …]`).
        #[serde(skip_serializing_if = "Option::is_none")]
        parameters: Option<serde_json::Value>,
        /// Max energy fee in SUN.
        #[serde(rename = "feeLimit", skip_serializing_if = "Option::is_none")]
        fee_limit: Option<Sun>,
        /// TRX (in SUN) to send with the call.
        #[serde(rename = "callValue", skip_serializing_if = "Option::is_none")]
        call_value: Option<Sun>,
    },
    /// Smart-contract deployment → `/sign/:id`.
    DeployContract {
        #[serde(flatten)]
        meta: RequestMeta,
        #[serde(skip_serializing_if = "Option::is_none")]
        network: Option<TronNetwork>,
        /// Expected owner address; the UI rejects a mismatch.
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<TronAddress>,
        /// Human-readable contract name (shown in the UI).
        #[serde(rename = "contractName", skip_serializing_if = "Option::is_none")]
        contract_name: Option<String>,
        /// Contract ABI (JSON array).
        abi: serde_json::Value,
        /// Compiled bytecode.
        bytecode: HexData,
        /// Constructor parameters (`[{type, value}, …]`).
        #[serde(skip_serializing_if = "Option::is_none")]
        parameters: Option<serde_json::Value>,
        /// Max energy fee in SUN.
        #[serde(rename = "feeLimit", skip_serializing_if = "Option::is_none")]
        fee_limit: Option<Sun>,
        /// TRX (in SUN) to send to the constructor.
        #[serde(rename = "callValue", skip_serializing_if = "Option::is_none")]
        call_value: Option<Sun>,
        /// Origin energy limit.
        #[serde(rename = "originEnergyLimit", skip_serializing_if = "Option::is_none")]
        origin_energy_limit: Option<EnergyLimit>,
        /// Percentage of fee the user pays (0-100).
        #[serde(rename = "userFeePercentage", skip_serializing_if = "Option::is_none")]
        user_fee_percentage: Option<Percentage>,
    },
    /// `signMessageV2` → `/sign/:id`.
    SignMessage {
        #[serde(flatten)]
        meta: RequestMeta,
        #[serde(skip_serializing_if = "Option::is_none")]
        network: Option<TronNetwork>,
        /// The message to sign.
        message: String,
        /// Address to sign with.
        #[serde(skip_serializing_if = "Option::is_none")]
        address: Option<TronAddress>,
    },
    /// TIP-712 typed-data signing → `/sign/:id`.
    SignTypedData {
        #[serde(flatten)]
        meta: RequestMeta,
        #[serde(skip_serializing_if = "Option::is_none")]
        network: Option<TronNetwork>,
        #[serde(flatten)]
        typed_data: TypedData,
        /// Address to sign with.
        #[serde(skip_serializing_if = "Option::is_none")]
        address: Option<TronAddress>,
    },
}

impl TronRequest {
    /// Which page the browser should open.
    pub const fn url_kind(&self) -> UrlKind {
        match self {
            Self::Connect { .. } => UrlKind::Connect,
            _ => UrlKind::Sign,
        }
    }

    const fn meta(&self) -> &RequestMeta {
        match self {
            Self::Connect { meta, .. }
            | Self::SendTransaction { meta, .. }
            | Self::TriggerContract { meta, .. }
            | Self::DeployContract { meta, .. }
            | Self::SignMessage { meta, .. }
            | Self::SignTypedData { meta, .. } => meta,
        }
    }
}

impl Request for TronRequest {
    fn id(&self) -> Uuid {
        self.meta().id
    }
}

/// Parameters for a native TRX transfer.
#[derive(Debug, Clone)]
pub struct SendTransactionParams {
    /// Recipient address.
    pub to: TronAddress,
    /// Expected `from` address.
    pub from: Option<TronAddress>,
    /// Amount in SUN.
    pub amount: Sun,
    /// Optional hex memo.
    pub data: Option<HexData>,
    /// Network.
    pub network: Option<TronNetwork>,
}

/// Parameters for a smart-contract call.
#[derive(Debug, Clone)]
pub struct TriggerContractParams {
    /// Contract address.
    pub contract_address: TronAddress,
    /// Expected `from` address.
    pub from: Option<TronAddress>,
    /// Function signature.
    pub function_selector: String,
    /// ABI parameter list.
    pub parameters: Option<serde_json::Value>,
    /// Max energy fee in SUN.
    pub fee_limit: Option<Sun>,
    /// TRX (in SUN) sent with the call.
    pub call_value: Option<Sun>,
    /// Network.
    pub network: Option<TronNetwork>,
}

/// Parameters for deploying a smart contract.
#[derive(Debug, Clone)]
pub struct DeployContractParams {
    /// Contract ABI (JSON array).
    pub abi: serde_json::Value,
    /// Compiled bytecode.
    pub bytecode: HexData,
    /// Human-readable contract name.
    pub contract_name: Option<String>,
    /// Constructor parameters (`[{type, value}, …]`).
    pub parameters: Option<serde_json::Value>,
    /// Expected owner address.
    pub from: Option<TronAddress>,
    /// Max energy fee in SUN.
    pub fee_limit: Option<Sun>,
    /// TRX (in SUN) to send to the constructor.
    pub call_value: Option<Sun>,
    /// Origin energy limit.
    pub origin_energy_limit: Option<EnergyLimit>,
    /// Percentage of fee the user pays (0-100).
    pub user_fee_percentage: Option<Percentage>,
    /// Network.
    pub network: Option<TronNetwork>,
}

impl TronRequest {
    /// Build a `connect` request.
    pub fn connect(network: Option<TronNetwork>, address: Option<TronAddress>) -> Self {
        Self::Connect {
            meta: RequestMeta::new(),
            network,
            address,
        }
    }

    /// Build a `send_transaction` request.
    pub fn send_transaction(params: SendTransactionParams) -> Self {
        Self::SendTransaction {
            meta: RequestMeta::new(),
            network: params.network,
            to: params.to,
            from: params.from,
            amount: params.amount,
            data: params.data,
        }
    }

    /// Build a `trigger_contract` request.
    pub fn trigger_contract(params: TriggerContractParams) -> Self {
        Self::TriggerContract {
            meta: RequestMeta::new(),
            network: params.network,
            contract_address: params.contract_address,
            from: params.from,
            function_selector: params.function_selector,
            parameters: params.parameters,
            fee_limit: params.fee_limit,
            call_value: params.call_value,
        }
    }

    /// Build a `deploy_contract` request.
    pub fn deploy_contract(params: DeployContractParams) -> Self {
        Self::DeployContract {
            meta: RequestMeta::new(),
            network: params.network,
            from: params.from,
            contract_name: params.contract_name,
            abi: params.abi,
            bytecode: params.bytecode,
            parameters: params.parameters,
            fee_limit: params.fee_limit,
            call_value: params.call_value,
            origin_energy_limit: params.origin_energy_limit,
            user_fee_percentage: params.user_fee_percentage,
        }
    }

    /// Build a `sign_message` request.
    pub fn sign_message(
        message: String,
        address: Option<TronAddress>,
        network: Option<TronNetwork>,
    ) -> Self {
        Self::SignMessage {
            meta: RequestMeta::new(),
            network,
            message,
            address,
        }
    }

    /// Build a `sign_typed_data` request.
    pub fn sign_typed_data(
        typed_data: TypedData,
        address: Option<TronAddress>,
        network: Option<TronNetwork>,
    ) -> Self {
        Self::SignTypedData {
            meta: RequestMeta::new(),
            network,
            typed_data,
            address,
        }
    }

    /// Build a request from a JSON body, the inverse of the wire serialization: the `type`
    /// discriminator selects the variant, the remaining fields fill it. Errors (as a
    /// human-readable reason) on an unknown `type`, a missing required field, or a field that
    /// fails its domain-type parse.
    ///
    /// One source of truth for the request wire shape, shared by the control API (`serve`) and
    /// the e2e harness so they cannot drift.
    pub fn from_json(body: &serde_json::Value) -> Result<Self, String> {
        let typ = str_field(body, "type")?;
        let network = opt_parsed(body, "network")?;

        match typ {
            "connect" => Ok(Self::connect(network, opt_parsed(body, "address")?)),
            "send_transaction" => Ok(Self::send_transaction(SendTransactionParams {
                to: req_parsed(body, "to")?,
                from: opt_parsed(body, "from")?,
                amount: req_parsed(body, "amount")?,
                data: opt_parsed(body, "data")?,
                network,
            })),
            "trigger_contract" => Ok(Self::trigger_contract(TriggerContractParams {
                contract_address: req_parsed(body, "contractAddress")?,
                from: opt_parsed(body, "from")?,
                function_selector: str_field(body, "functionSelector")?.to_owned(),
                parameters: body.get("parameters").cloned(),
                fee_limit: opt_parsed(body, "feeLimit")?,
                call_value: opt_parsed(body, "callValue")?,
                network,
            })),
            "deploy_contract" => Ok(Self::deploy_contract(DeployContractParams {
                abi: body.get("abi").cloned().ok_or("missing field 'abi'")?,
                bytecode: req_parsed(body, "bytecode")?,
                contract_name: body
                    .get("contractName")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                parameters: body.get("parameters").cloned(),
                from: opt_parsed(body, "from")?,
                fee_limit: opt_parsed(body, "feeLimit")?,
                call_value: opt_parsed(body, "callValue")?,
                origin_energy_limit: opt_parsed(body, "originEnergyLimit")?,
                user_fee_percentage: opt_parsed(body, "userFeePercentage")?,
                network,
            })),
            "sign_message" => Ok(Self::sign_message(
                str_field(body, "message")?.to_owned(),
                opt_parsed(body, "address")?,
                network,
            )),
            "sign_typed_data" => Ok(Self::sign_typed_data(
                TypedData {
                    domain: json_field(body, "domain"),
                    types: json_field(body, "types"),
                    primary_type: str_field(body, "primaryType")?.to_owned(),
                    message: json_field(body, "message"),
                },
                opt_parsed(body, "address")?,
                network,
            )),
            other => Err(format!("unknown request type: {other}")),
        }
    }
}

/// Read a required string field, or a "missing/!string" reason.
fn str_field<'a>(body: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    body.get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("missing or non-string field '{key}'"))
}

/// Read an open-ended JSON sub-object, defaulting to `{}` when absent (for TIP-712 parts).
fn json_field(body: &serde_json::Value, key: &str) -> serde_json::Value {
    body.get(key)
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}))
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
    fn send_transaction_emits_wire_shape() {
        let req = TronRequest::send_transaction(SendTransactionParams {
            to: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC".parse().unwrap(),
            from: None,
            amount: "1500000".parse().unwrap(),
            data: None,
            network: Some(TronNetwork::Mainnet),
        });
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["type"], "send_transaction");
        assert_eq!(json["amount"], "1500000");
        assert_eq!(json["network"], "mainnet");
        assert_eq!(json["to"], "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC");
    }

    #[test]
    fn trigger_contract_uses_camelcase() {
        let req = TronRequest::trigger_contract(TriggerContractParams {
            contract_address: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC".parse().unwrap(),
            from: None,
            function_selector: "transfer(address,uint256)".into(),
            parameters: Some(serde_json::json!([{"type":"uint256","value":"1"}])),
            fee_limit: Some("150000000".parse().unwrap()),
            call_value: None,
            network: None,
        });
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["type"], "trigger_contract");
        assert_eq!(json["functionSelector"], "transfer(address,uint256)");
        assert_eq!(json["feeLimit"], "150000000");
        assert!(json.get("callValue").is_none());
    }

    #[test]
    fn from_json_round_trips_trigger_contract() {
        let original = TronRequest::trigger_contract(TriggerContractParams {
            contract_address: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC".parse().unwrap(),
            from: None,
            function_selector: "transfer(address,uint256)".into(),
            parameters: Some(serde_json::json!([{ "type": "uint256", "value": "1" }])),
            fee_limit: Some("150000000".parse().unwrap()),
            call_value: None,
            network: Some(TronNetwork::Mainnet),
        });
        let wire = serde_json::to_value(&original).unwrap();
        let parsed = TronRequest::from_json(&wire).unwrap();
        let reparsed = serde_json::to_value(&parsed).unwrap();
        assert_eq!(wire["type"], reparsed["type"]);
        assert_eq!(wire["contractAddress"], reparsed["contractAddress"]);
        assert_eq!(wire["functionSelector"], reparsed["functionSelector"]);
        assert_eq!(wire["feeLimit"], reparsed["feeLimit"]);
        assert_eq!(wire["parameters"], reparsed["parameters"]);
        assert_eq!(wire["network"], reparsed["network"]);
    }

    #[test]
    fn from_json_parses_deploy_contract() {
        let req = TronRequest::from_json(&serde_json::json!({
            "type": "deploy_contract",
            "abi": [{ "type": "constructor", "inputs": [] }],
            "bytecode": "0x6080",
            "contractName": "Greeter",
            "feeLimit": "1500000000",
            "network": "mainnet",
        }))
        .unwrap();
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["type"], "deploy_contract");
        assert_eq!(json["contractName"], "Greeter");
        assert_eq!(json["feeLimit"], "1500000000");
    }

    #[test]
    fn from_json_rejects_unknown_type_and_bad_field() {
        assert!(TronRequest::from_json(&serde_json::json!({ "type": "nope" })).is_err());
        // Missing required `to`.
        assert!(
            TronRequest::from_json(&serde_json::json!({ "type": "send_transaction" })).is_err()
        );
        // Present but invalid Base58Check address.
        let bad = serde_json::json!({ "type": "connect", "address": "Tnot-valid" });
        assert!(TronRequest::from_json(&bad).is_err());
    }
}
