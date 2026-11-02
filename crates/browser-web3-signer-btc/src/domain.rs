//! Bitcoin domain types.
//!
//! Networks, network-checked addresses, sat amounts, fee rates, PSBTs and message signatures.
//! Each validates on construction and serializes to the exact wire shape the embedded UI expects.

use std::fmt;
use std::num::NonZeroU64;
use std::str::FromStr;

use bitcoin::address::NetworkUnchecked;
use bitcoin::base64::Engine as _;
use bitcoin::base64::engine::general_purpose::STANDARD as BASE64;
use bitcoin::hex::FromHex;
use bitcoin::{Address, Psbt, Txid};
use serde::{Serialize, Serializer};

pub use browser_web3_signer_core::DomainParseError;

/// A Bitcoin network. Serializes as its lowercase id. Unisat supports all but regtest; Leather
/// supports all of them (see `docs/adr/0001-bitcoin-support.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BtcNetwork {
    /// Bitcoin mainnet.
    Mainnet,
    /// testnet3.
    Testnet,
    /// testnet4.
    Testnet4,
    /// The default signet.
    Signet,
    /// A local regtest chain.
    Regtest,
}

impl BtcNetwork {
    /// The lowercase network id.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Mainnet => "mainnet",
            Self::Testnet => "testnet",
            Self::Testnet4 => "testnet4",
            Self::Signet => "signet",
            Self::Regtest => "regtest",
        }
    }

    /// The rust-bitcoin network, for address validation.
    pub const fn to_bitcoin(self) -> bitcoin::Network {
        match self {
            Self::Mainnet => bitcoin::Network::Bitcoin,
            Self::Testnet => bitcoin::Network::Testnet,
            Self::Testnet4 => bitcoin::Network::Testnet4,
            Self::Signet => bitcoin::Network::Signet,
            Self::Regtest => bitcoin::Network::Regtest,
        }
    }
}

impl fmt::Display for BtcNetwork {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

impl FromStr for BtcNetwork {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "mainnet" => Ok(Self::Mainnet),
            "testnet" => Ok(Self::Testnet),
            "testnet4" => Ok(Self::Testnet4),
            "signet" => Ok(Self::Signet),
            "regtest" => Ok(Self::Regtest),
            _ => Err(DomainParseError::new(
                "bitcoin network",
                s,
                "expected mainnet|testnet|testnet4|signet|regtest",
            )),
        }
    }
}

impl Serialize for BtcNetwork {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.id())
    }
}

/// A syntactically valid Bitcoin address whose network is not yet known. Becomes a
/// [`BtcAddress`] once checked against the request's network ([`Self::require_network`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UncheckedAddress(Address<NetworkUnchecked>);

impl UncheckedAddress {
    /// Check the address belongs to `network` (a `tb1…` address is valid on testnet, testnet4
    /// and signet alike; `bc1…` only on mainnet).
    pub fn require_network(self, network: BtcNetwork) -> Result<BtcAddress, DomainParseError> {
        if self.0.is_valid_for_network(network.to_bitcoin()) {
            return Ok(BtcAddress(self.0.assume_checked()));
        }
        Err(DomainParseError::new(
            "bitcoin address",
            &self.0.assume_checked_ref().to_string(),
            format!("not a {network} address"),
        ))
    }
}

impl FromStr for UncheckedAddress {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<Address<NetworkUnchecked>>()
            .map(Self)
            .map_err(|e| DomainParseError::new("bitcoin address", s, e))
    }
}

/// A Bitcoin address checked against its network. Serializes in its canonical form (bech32
/// lowercase, base58 as-is).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BtcAddress(Address);

impl BtcAddress {
    /// The rust-bitcoin address.
    pub const fn as_bitcoin(&self) -> &Address {
        &self.0
    }
}

impl fmt::Display for BtcAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

impl Serialize for BtcAddress {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&self.0)
    }
}

/// An amount in satoshis. Serialized as a decimal string to preserve precision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Sats(pub u64);

impl Sats {
    /// The raw satoshi value.
    pub const fn get(self) -> u64 {
        self.0
    }

    /// Format as a BTC decimal string (8 decimals, no trailing zeros).
    pub fn to_btc_string(self) -> String {
        let s = format!("{}.{:08}", self.0 / 100_000_000, self.0 % 100_000_000);
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    }
}

impl FromStr for Sats {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>()
            .map(Sats)
            .map_err(|e| DomainParseError::new("sat amount", s, e))
    }
}

impl fmt::Display for Sats {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for Sats {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&self.0)
    }
}

/// A fee rate in sat/vB (non-zero). Serialized as a decimal string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SatPerVb(NonZeroU64);

impl FromStr for SatPerVb {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<NonZeroU64>()
            .map(SatPerVb)
            .map_err(|e| DomainParseError::new("fee rate (sat/vB)", s, e))
    }
}

impl fmt::Display for SatPerVb {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for SatPerVb {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&self.0)
    }
}

/// A parsed PSBT (BIP-174). Parses from hex or base64; serializes as hex, the form Unisat's
/// `signPsbt` takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PsbtData(Psbt);

impl PsbtData {
    /// The rust-bitcoin PSBT.
    pub const fn as_psbt(&self) -> &Psbt {
        &self.0
    }

    /// The txid of the unsigned transaction. Signing must not change it.
    pub fn unsigned_txid(&self) -> Txid {
        self.0.unsigned_tx.compute_txid()
    }
}

impl FromStr for PsbtData {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.trim();
        let bytes = if s.bytes().all(|b| b.is_ascii_hexdigit()) {
            Vec::<u8>::from_hex(s).map_err(|e| DomainParseError::new("psbt", s, e))?
        } else {
            BASE64
                .decode(s)
                .map_err(|e| DomainParseError::new("psbt", s, e))?
        };
        Psbt::deserialize(&bytes)
            .map(Self)
            .map_err(|e| DomainParseError::new("psbt", s, e))
    }
}

impl fmt::Display for PsbtData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.serialize_hex())
    }
}

impl Serialize for PsbtData {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.serialize_hex())
    }
}

/// Which message-signing scheme to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MessageProtocol {
    /// BIP-322 "simple" (Unisat `bip322-simple`); works for every address type.
    #[default]
    Bip322,
    /// Legacy ECDSA (BIP-137 style, Unisat `ecdsa`).
    Ecdsa,
}

impl MessageProtocol {
    /// The wire id.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Bip322 => "bip322",
            Self::Ecdsa => "ecdsa",
        }
    }
}

impl FromStr for MessageProtocol {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "bip322" => Ok(Self::Bip322),
            "ecdsa" => Ok(Self::Ecdsa),
            _ => Err(DomainParseError::new(
                "message protocol",
                s,
                "expected bip322|ecdsa",
            )),
        }
    }
}

impl fmt::Display for MessageProtocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

impl Serialize for MessageProtocol {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.id())
    }
}

/// A message signature as the wallet returns it: base64 bytes (65 for ECDSA, a serialized
/// witness for BIP-322).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageSignature(Vec<u8>);

impl FromStr for MessageSignature {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let bytes = BASE64
            .decode(s)
            .map_err(|e| DomainParseError::new("message signature", s, e))?;
        if bytes.is_empty() {
            return Err(DomainParseError::new("message signature", s, "empty"));
        }
        Ok(Self(bytes))
    }
}

impl fmt::Display for MessageSignature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&BASE64.encode(&self.0))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A one-input, one-output PSBT (rust-bitcoin's `psbt` test vectors).
    pub(crate) const PSBT_HEX: &str = "70736274ff01003f0200000001ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000000ffffffff010000000000000000036a010000000000000a0f0102030405060708090f0102030405060708090a0b0c0d0e0f0000";

    #[test]
    fn network_round_trips() {
        assert_eq!(
            "TESTNET4".parse::<BtcNetwork>().unwrap(),
            BtcNetwork::Testnet4
        );
        assert_eq!(
            serde_json::to_value(BtcNetwork::Signet).unwrap(),
            serde_json::json!("signet")
        );
        assert_eq!(
            "regtest".parse::<BtcNetwork>().unwrap(),
            BtcNetwork::Regtest
        );
        assert!("devnet".parse::<BtcNetwork>().is_err());
    }

    #[test]
    fn address_is_checked_against_network() {
        let main: UncheckedAddress = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
            .parse()
            .unwrap();
        assert!(main.clone().require_network(BtcNetwork::Mainnet).is_ok());
        assert!(main.require_network(BtcNetwork::Signet).is_err());

        let test: UncheckedAddress = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"
            .parse()
            .unwrap();
        let checked = test.clone().require_network(BtcNetwork::Testnet4).unwrap();
        assert_eq!(
            checked.to_string(),
            "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"
        );
        assert!(test.require_network(BtcNetwork::Mainnet).is_err());
        assert!("bc1qnotanaddress".parse::<UncheckedAddress>().is_err());
    }

    #[test]
    fn sats_format_as_btc() {
        assert_eq!(Sats(150_000_000).to_btc_string(), "1.5");
        assert_eq!(Sats(1).to_btc_string(), "0.00000001");
        assert_eq!(Sats(100_000_000).to_btc_string(), "1");
        assert_eq!(Sats(0).to_btc_string(), "0");
        assert!("-1".parse::<Sats>().is_err());
        assert!("0".parse::<SatPerVb>().is_err());
    }

    #[test]
    fn psbt_parses_hex_and_base64_and_serializes_hex() {
        let from_hex: PsbtData = PSBT_HEX.parse().unwrap();
        let b64 = BASE64.encode(from_hex.as_psbt().serialize());
        let from_b64: PsbtData = b64.parse().unwrap();
        assert_eq!(from_hex, from_b64);
        assert_eq!(from_hex.to_string(), PSBT_HEX);
        // The e2e mock wallet's pushPsbt returns this txid (tests/e2e-browser/btc/fixtures).
        assert_eq!(
            from_hex.unsigned_txid().to_string(),
            "75c5c9665a570569ad77dd1279e6fd4628a093c4dcbf8d41532614044c14c115"
        );
        assert!("70736274".parse::<PsbtData>().is_err());
    }

    #[test]
    fn message_signature_is_base64() {
        let sig: MessageSignature = "AkcwRAIg".parse().unwrap();
        assert_eq!(sig.to_string(), "AkcwRAIg");
        assert!("not base64!".parse::<MessageSignature>().is_err());
        assert!("".parse::<MessageSignature>().is_err());
    }
}
