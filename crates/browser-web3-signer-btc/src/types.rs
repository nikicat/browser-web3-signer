//! Bitcoin request types. JSON serialization must match what the embedded UI fetches from
//! `GET /api/pending/:id`.
//!
//! Every request carries its network, and every address in it is checked against that network
//! when the request is built, so a mainnet address on a signet request never reaches the wallet.

use browser_web3_signer_core::parse::{opt_parsed, req_parsed, str_field};
use browser_web3_signer_core::{DomainParseError, Request, RequestMeta, UrlKind};
use serde::Serialize;
use uuid::Uuid;

use crate::config;
use crate::domain::{
    BtcAddress, BtcNetwork, MessageProtocol, PsbtData, SatPerVb, Sats, UncheckedAddress,
};

/// A pending Bitcoin request. The `type` discriminator is derived from the variant; fields use
/// camelCase to match the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BtcRequest {
    /// Wallet connection → `/connect/:id`.
    Connect {
        #[serde(flatten)]
        meta: RequestMeta,
        network: BtcNetwork,
        /// Expected wallet address; the UI rejects a mismatch.
        #[serde(skip_serializing_if = "Option::is_none")]
        address: Option<BtcAddress>,
    },
    /// Pay one address; the wallet selects coins, signs and broadcasts → `/sign/:id`.
    SendTransfer {
        #[serde(flatten)]
        meta: RequestMeta,
        network: BtcNetwork,
        /// Recipient.
        to: BtcAddress,
        /// Expected sender; the UI rejects a mismatch.
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<BtcAddress>,
        /// Amount in sats.
        amount: Sats,
        /// Fee-rate hint in sat/vB.
        #[serde(rename = "feeRate", skip_serializing_if = "Option::is_none")]
        fee_rate: Option<SatPerVb>,
    },
    /// Sign a caller-built PSBT → `/sign/:id`.
    SignPsbt {
        #[serde(flatten)]
        meta: RequestMeta,
        network: BtcNetwork,
        /// The PSBT to sign (hex on the wire).
        psbt: PsbtData,
        /// Expected signer; the UI rejects a mismatch.
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<BtcAddress>,
        /// Input indexes to sign; absent means every input the wallet's account owns.
        #[serde(rename = "signInputs", skip_serializing_if = "Option::is_none")]
        sign_inputs: Option<Vec<u32>>,
        /// Finalize the signed inputs. Always true when `broadcast` is.
        finalize: bool,
        /// Broadcast through the wallet after signing.
        broadcast: bool,
    },
    /// Sign a text message → `/sign/:id`.
    SignMessage {
        #[serde(flatten)]
        meta: RequestMeta,
        network: BtcNetwork,
        /// The message to sign.
        message: String,
        /// Address to sign with.
        #[serde(skip_serializing_if = "Option::is_none")]
        address: Option<BtcAddress>,
        /// Signature scheme.
        protocol: MessageProtocol,
    },
}

/// Parameters for a `send_transfer`.
#[derive(Debug, Clone)]
pub struct SendTransferParams {
    /// Network.
    pub network: BtcNetwork,
    /// Recipient.
    pub to: UncheckedAddress,
    /// Expected sender.
    pub from: Option<UncheckedAddress>,
    /// Amount in sats.
    pub amount: Sats,
    /// Fee-rate hint.
    pub fee_rate: Option<SatPerVb>,
}

/// Parameters for a `sign_psbt`.
#[derive(Debug, Clone)]
pub struct SignPsbtParams {
    /// Network.
    pub network: BtcNetwork,
    /// The PSBT to sign.
    pub psbt: PsbtData,
    /// Expected signer.
    pub from: Option<UncheckedAddress>,
    /// Input indexes to sign; `None` signs every input the account owns.
    pub sign_inputs: Option<Vec<u32>>,
    /// Finalize the signed inputs.
    pub finalize: bool,
    /// Broadcast after signing (implies `finalize`).
    pub broadcast: bool,
}

/// Parameters for a `sign_message`.
#[derive(Debug, Clone)]
pub struct SignMessageParams {
    /// Network.
    pub network: BtcNetwork,
    /// The message to sign.
    pub message: String,
    /// Address to sign with.
    pub address: Option<UncheckedAddress>,
    /// Signature scheme.
    pub protocol: MessageProtocol,
}

/// Check an optional address against the request's network.
fn checked(
    address: Option<UncheckedAddress>,
    network: BtcNetwork,
) -> Result<Option<BtcAddress>, DomainParseError> {
    address.map(|a| a.require_network(network)).transpose()
}

impl BtcRequest {
    const fn meta(&self) -> &RequestMeta {
        match self {
            Self::Connect { meta, .. }
            | Self::SendTransfer { meta, .. }
            | Self::SignPsbt { meta, .. }
            | Self::SignMessage { meta, .. } => meta,
        }
    }

    /// Build a `connect` request.
    pub fn connect(
        network: BtcNetwork,
        address: Option<UncheckedAddress>,
    ) -> Result<Self, DomainParseError> {
        Ok(Self::Connect {
            meta: RequestMeta::new(),
            network,
            address: checked(address, network)?,
        })
    }

    /// Build a `send_transfer` request.
    pub fn send_transfer(params: SendTransferParams) -> Result<Self, DomainParseError> {
        let network = params.network;
        Ok(Self::SendTransfer {
            meta: RequestMeta::new(),
            network,
            to: params.to.require_network(network)?,
            from: checked(params.from, network)?,
            amount: params.amount,
            fee_rate: params.fee_rate,
        })
    }

    /// Build a `sign_psbt` request. Fails if a `sign_inputs` index is out of range.
    pub fn sign_psbt(params: SignPsbtParams) -> Result<Self, DomainParseError> {
        let network = params.network;
        let inputs = params.psbt.as_psbt().inputs.len();
        if let Some(bad) = params
            .sign_inputs
            .iter()
            .flatten()
            .find(|&&i| i as usize >= inputs)
        {
            return Err(DomainParseError::new(
                "sign input index",
                &bad.to_string(),
                format!("the PSBT has {inputs} inputs"),
            ));
        }
        Ok(Self::SignPsbt {
            meta: RequestMeta::new(),
            network,
            psbt: params.psbt,
            from: checked(params.from, network)?,
            sign_inputs: params.sign_inputs,
            finalize: params.finalize || params.broadcast,
            broadcast: params.broadcast,
        })
    }

    /// Build a `sign_message` request.
    pub fn sign_message(params: SignMessageParams) -> Result<Self, DomainParseError> {
        let network = params.network;
        Ok(Self::SignMessage {
            meta: RequestMeta::new(),
            network,
            message: params.message,
            address: checked(params.address, network)?,
            protocol: params.protocol,
        })
    }
}

impl Request for BtcRequest {
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
        let network = opt_parsed(body, "network")?.unwrap_or_else(config::default_network);

        let built = match typ {
            "connect" => Self::connect(network, opt_parsed(body, "address")?),
            "send_transfer" => Self::send_transfer(SendTransferParams {
                network,
                to: req_parsed(body, "to")?,
                from: opt_parsed(body, "from")?,
                amount: req_parsed(body, "amount")?,
                fee_rate: opt_parsed(body, "feeRate")?,
            }),
            "sign_psbt" => Self::sign_psbt(SignPsbtParams {
                network,
                psbt: req_parsed(body, "psbt")?,
                from: opt_parsed(body, "from")?,
                sign_inputs: sign_inputs_field(body)?,
                finalize: bool_field(body, "finalize")?,
                broadcast: bool_field(body, "broadcast")?,
            }),
            "sign_message" => Self::sign_message(SignMessageParams {
                network,
                message: str_field(body, "message")?.to_owned(),
                address: opt_parsed(body, "address")?,
                protocol: opt_parsed(body, "protocol")?.unwrap_or_default(),
            }),
            other => return Err(format!("unknown request type: {other}")),
        };
        built.map_err(|e| e.to_string())
    }
}

/// Read an optional boolean field, defaulting to `false`.
fn bool_field(body: &serde_json::Value, key: &str) -> Result<bool, String> {
    body.get(key).map_or(Ok(false), |v| {
        v.as_bool()
            .ok_or_else(|| format!("non-boolean field '{key}'"))
    })
}

/// Read `signInputs`: an optional array of input indexes.
fn sign_inputs_field(body: &serde_json::Value) -> Result<Option<Vec<u32>>, String> {
    body.get("signInputs")
        .map(|v| {
            v.as_array()
                .ok_or("'signInputs' must be an array")?
                .iter()
                .map(|i| {
                    i.as_u64()
                        .and_then(|n| u32::try_from(n).ok())
                        .ok_or_else(|| format!("invalid 'signInputs' index {i}"))
                })
                .collect()
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::tests::PSBT_HEX;

    const MAIN: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const TEST: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

    #[test]
    fn send_transfer_emits_wire_shape() {
        let req = BtcRequest::send_transfer(SendTransferParams {
            network: BtcNetwork::Signet,
            to: TEST.parse().unwrap(),
            from: None,
            amount: Sats(1500),
            fee_rate: Some("3".parse().unwrap()),
        })
        .unwrap();
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["type"], "send_transfer");
        assert_eq!(json["network"], "signet");
        assert_eq!(json["to"], TEST);
        assert_eq!(json["amount"], "1500");
        assert_eq!(json["feeRate"], "3");
        assert!(json.get("from").is_none());
    }

    #[test]
    fn address_on_the_wrong_network_is_rejected_at_build() {
        let err = BtcRequest::send_transfer(SendTransferParams {
            network: BtcNetwork::Signet,
            to: MAIN.parse().unwrap(),
            from: None,
            amount: Sats(1),
            fee_rate: None,
        });
        assert!(err.is_err());
        let wire = serde_json::json!({ "type": "connect", "network": "mainnet", "address": TEST });
        assert!(BtcRequest::from_json(&wire).is_err());
    }

    #[test]
    fn sign_psbt_broadcast_implies_finalize_and_checks_indexes() {
        let psbt: PsbtData = PSBT_HEX.parse().unwrap();
        let req = BtcRequest::from_json(&serde_json::json!({
            "type": "sign_psbt",
            "network": "mainnet",
            "psbt": psbt.to_string(),
            "signInputs": [0],
            "broadcast": true,
        }))
        .unwrap();
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["finalize"], true);
        assert_eq!(json["broadcast"], true);
        assert_eq!(json["signInputs"], serde_json::json!([0]));
        assert_eq!(json["psbt"], PSBT_HEX);

        let out_of_range = serde_json::json!({
            "type": "sign_psbt", "network": "mainnet", "psbt": psbt.to_string(), "signInputs": [1],
        });
        assert!(BtcRequest::from_json(&out_of_range).is_err());
    }

    #[test]
    fn sign_message_defaults_to_bip322() {
        let req = BtcRequest::from_json(&serde_json::json!({
            "type": "sign_message", "network": "mainnet", "message": "hi", "address": MAIN,
        }))
        .unwrap();
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["protocol"], "bip322");
        assert_eq!(json["address"], MAIN);
    }

    #[test]
    fn from_json_rejects_unknown_type_and_missing_fields() {
        assert!(BtcRequest::from_json(&serde_json::json!({ "type": "nope" })).is_err());
        let no_to = serde_json::json!({ "type": "send_transfer", "amount": "1" });
        assert!(BtcRequest::from_json(&no_to).is_err());
        let bad_bool = serde_json::json!({
            "type": "sign_psbt", "psbt": PSBT_HEX, "finalize": "yes",
        });
        assert!(BtcRequest::from_json(&bad_bool).is_err());
    }
}
