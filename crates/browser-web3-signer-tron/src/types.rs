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
}
