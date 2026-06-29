//! EVM request types. Their JSON serialization must match what the embedded UI fetches from
//! `GET /api/pending/:id` (ported from `browser-evm-signer/src/types.ts`).
//!
//! The request *kind* is the enum variant itself (serde-tagged via `type`), not a stored
//! string — there is one source of truth for the discriminator.

use browser_web3_signer_core::{Request, RequestMeta, UrlKind};
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
    /// Which page the browser should open for this request.
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
            | Self::SignMessage { meta, .. }
            | Self::SignTypedData { meta, .. } => meta,
        }
    }
}

impl Request for EvmRequest {
    fn id(&self) -> Uuid {
        self.meta().id
    }
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
    /// Build a `connect` request with a fresh id.
    pub fn connect(chain_id: Option<ChainId>, address: Option<Address>) -> Self {
        Self::Connect {
            meta: RequestMeta::new(),
            chain_id,
            address,
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
}
