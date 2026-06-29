//! TRON domain types: Base58Check addresses, SUN amounts, networks, tx ids, and signatures.
//! Each validates on construction and serializes to the exact wire shape the embedded UI expects.

use std::fmt;
use std::str::FromStr;

use alloy_primitives::{
    U256, hex,
    utils::{UnitsError, format_units},
};
use serde::{Serialize, Serializer};

/// TRX uses 6 decimals: 1 TRX = 1,000,000 SUN.
pub const TRX_DECIMALS: u8 = 6;

/// A TRON network. Serializes as its lowercase id (`"mainnet"`, `"shasta"`, `"nile"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TronNetwork {
    /// Tron Mainnet.
    Mainnet,
    /// Shasta testnet.
    Shasta,
    /// Nile testnet.
    Nile,
}

impl TronNetwork {
    /// The lowercase network id.
    pub fn id(self) -> &'static str {
        match self {
            TronNetwork::Mainnet => "mainnet",
            TronNetwork::Shasta => "shasta",
            TronNetwork::Nile => "nile",
        }
    }
}

impl fmt::Display for TronNetwork {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

impl FromStr for TronNetwork {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "mainnet" => Ok(TronNetwork::Mainnet),
            "shasta" => Ok(TronNetwork::Shasta),
            "nile" => Ok(TronNetwork::Nile),
            _ => Err(DomainParseError::new(
                "tron network",
                s,
                "expected mainnet|shasta|nile",
            )),
        }
    }
}

impl Serialize for TronNetwork {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.id())
    }
}

/// A TRON address stored as its canonical 21 bytes: the `0x41` mainnet prefix followed by the
/// 20-byte body. Parsed from / serialized to the Base58**Check** string form (checksum verified).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TronAddress([u8; 21]);

impl TronAddress {
    /// The raw 21 bytes (`0x41` prefix + 20-byte body).
    pub fn as_bytes(&self) -> &[u8; 21] {
        &self.0
    }

    /// The 20-byte address body (without the `0x41` prefix).
    pub fn body(&self) -> [u8; 20] {
        self.0[1..]
            .try_into()
            .expect("21-byte address always has a 20-byte body")
    }

    /// The 20-byte body as lowercase hex (no `41` prefix, no `0x`), for ABI encoding.
    pub fn to_hex20(&self) -> String {
        hex::encode(self.body())
    }

    /// The canonical Base58Check string form (`T…`).
    pub fn to_base58(&self) -> String {
        bs58::encode(self.0).with_check().into_string()
    }
}

impl FromStr for TronAddress {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        // `with_check` verifies and strips the 4-byte checksum, returning the 21-byte payload.
        let decoded = bs58::decode(s)
            .with_check(None)
            .into_vec()
            .map_err(|e| DomainParseError::new("tron address", s, e))?;
        let bytes: [u8; 21] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| DomainParseError::new("tron address", s, "expected 21-byte payload"))?;
        if bytes[0] != 0x41 {
            return Err(DomainParseError::new(
                "tron address",
                s,
                "expected 0x41 prefix",
            ));
        }
        Ok(TronAddress(bytes))
    }
}

impl fmt::Display for TronAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_base58())
    }
}

impl Serialize for TronAddress {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_base58())
    }
}

/// An amount in SUN (1 TRX = 1,000,000 SUN). Serialized as a decimal string to preserve precision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Sun(pub u64);

impl Sun {
    /// The raw SUN value.
    pub fn get(self) -> u64 {
        self.0
    }

    /// Format as a TRX decimal string (6 decimals, no trailing zeros).
    pub fn to_trx_string(self) -> String {
        format_units(U256::from(self.0), TRX_DECIMALS).unwrap_or_else(|_| self.0.to_string())
    }
}

impl From<u64> for Sun {
    fn from(v: u64) -> Self {
        Sun(v)
    }
}

impl FromStr for Sun {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>()
            .map(Sun)
            .map_err(|e| DomainParseError::new("sun amount", s, e))
    }
}

impl fmt::Display for Sun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for Sun {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

// Transaction hashes and ECDSA signatures are identical across EVM and TRON, so they live in
// the core crate and are re-exported here. (TRON renders the tx hash without a `0x` prefix via
// `TxHash::to_hex()`.)
pub use browser_web3_signer_core::{Signature, TxHash};

/// An energy limit for contract deployment/execution (TRON resource units). Serializes as a
/// JSON number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EnergyLimit(pub u64);

impl EnergyLimit {
    /// The raw value.
    pub fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for EnergyLimit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for EnergyLimit {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>()
            .map(EnergyLimit)
            .map_err(|e| DomainParseError::new("energy limit", s, e))
    }
}

impl Serialize for EnergyLimit {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(self.0)
    }
}

/// A percentage in the range 0–100 (TRON `userFeePercentage`). Validated on construction;
/// serializes as a JSON number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Percentage(u8);

impl Percentage {
    /// Construct, rejecting values above 100.
    pub fn new(value: u8) -> Result<Self, DomainParseError> {
        if value > 100 {
            return Err(DomainParseError::new(
                "percentage",
                &value.to_string(),
                "must be 0-100",
            ));
        }
        Ok(Percentage(value))
    }

    /// The raw value (0–100).
    pub fn get(self) -> u8 {
        self.0
    }
}

impl fmt::Display for Percentage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for Percentage {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let value = s
            .parse::<u8>()
            .map_err(|e| DomainParseError::new("percentage", s, e))?;
        Percentage::new(value)
    }
}

impl Serialize for Percentage {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u8(self.0)
    }
}

/// Number of decimal places a token uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Decimals(pub u8);

impl Decimals {
    /// The raw decimal count.
    pub fn get(self) -> u8 {
        self.0
    }
}

impl fmt::Display for Decimals {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A token/currency ticker symbol.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Symbol(String);

impl Symbol {
    /// Wrap a symbol string.
    pub fn new(s: impl Into<String>) -> Self {
        Symbol(s.into())
    }

    /// The symbol as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// True if the contract reported no symbol.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Display for Symbol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A TRC-20 token amount: a raw integer plus the token's [`Decimals`]. Renders itself as a
/// human-readable decimal without a redundant pre-formatted string field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenAmount {
    raw: U256,
    decimals: Decimals,
}

impl TokenAmount {
    /// Build from a raw integer and decimal scale.
    pub fn new(raw: U256, decimals: Decimals) -> Self {
        TokenAmount { raw, decimals }
    }

    /// The raw, unscaled value.
    pub fn raw(self) -> U256 {
        self.raw
    }

    /// The token's decimal scale.
    pub fn decimals(self) -> Decimals {
        self.decimals
    }

    /// Render as a human-readable decimal string.
    pub fn to_decimal_string(self) -> String {
        format_units(self.raw, self.decimals.0).unwrap_or_else(|_| self.raw.to_string())
    }
}

impl fmt::Display for TokenAmount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_decimal_string())
    }
}

/// Convert a TRX decimal string to SUN, for CLI ergonomics.
pub fn trx_to_sun(value: &str) -> Result<Sun, UnitsError> {
    let units = alloy_primitives::utils::parse_units(value, TRX_DECIMALS)?;
    let raw: U256 = units.get_absolute();
    Ok(Sun(raw.to::<u64>()))
}

/// Error parsing a string into a TRON domain type.
#[derive(Debug)]
pub struct DomainParseError {
    kind: &'static str,
    input: String,
    source: String,
}

impl DomainParseError {
    fn new(kind: &'static str, input: &str, source: impl fmt::Display) -> Self {
        Self {
            kind,
            input: input.to_string(),
            source: source.to_string(),
        }
    }
}

impl fmt::Display for DomainParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid {} {:?}: {}", self.kind, self.input, self.source)
    }
}

impl std::error::Error for DomainParseError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_roundtrip() {
        assert_eq!(
            "MAINNET".parse::<TronNetwork>().unwrap(),
            TronNetwork::Mainnet
        );
        assert_eq!(
            serde_json::to_value(TronNetwork::Nile).unwrap(),
            serde_json::json!("nile")
        );
        assert!("foo".parse::<TronNetwork>().is_err());
    }

    #[test]
    fn address_validates_and_serializes() {
        // A well-formed mainnet address (Tron foundation address).
        let a: TronAddress = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC".parse().unwrap();
        assert_eq!(
            serde_json::to_value(a).unwrap(),
            serde_json::json!("TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC")
        );
        assert_eq!(a.to_hex20().len(), 40);
        assert!("0xabc".parse::<TronAddress>().is_err());
    }

    #[test]
    fn sun_serializes_decimal_and_formats_trx() {
        let s: Sun = "1500000".parse().unwrap();
        assert_eq!(
            serde_json::to_value(s).unwrap(),
            serde_json::json!("1500000")
        );
        assert_eq!(s.to_trx_string(), "1.500000");
    }

    #[test]
    fn txhash_requires_32_bytes() {
        assert!("ab".parse::<TxHash>().is_err());
        let t: TxHash = "aa".repeat(32).parse().unwrap();
        assert_eq!(t.to_hex().len(), 64);
    }
}
