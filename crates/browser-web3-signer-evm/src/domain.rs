//! EVM domain types.
//!
//! These wrap `alloy` primitives so values are validated at construction and serialize to the
//! exact wire shape the embedded UI expects:
//! - [`Address`] → lowercase `0x…` (the UI compares case-insensitively)
//! - [`Wei`] → decimal string (the UI's `formatEther`/wallet path expects decimal wei)
//! - [`CallData`] → `0x`-prefixed hex
//! - [`ChainId`] → a JSON number
//!
//! Transaction hashes and signatures are chain-agnostic, so they live in the core crate
//! ([`browser_web3_signer_core::TxHash`], [`browser_web3_signer_core::Signature`]) and are
//! re-exported from this crate.
//!
//! Using these instead of bare `String`/`u64` keeps the request/result types honest: a value
//! that "is an address" cannot be confused with one that "is a tx hash".

use std::fmt;
use std::str::FromStr;

use alloy::primitives::{
    Address as AlloyAddress, Bytes, U256,
    utils::{UnitsError, format_ether, format_units},
};
use serde::{Serialize, Serializer};

pub use browser_web3_signer_core::{Signature, TxHash};

/// An EVM chain id (e.g. `1` for Ethereum mainnet). Serializes as a JSON number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChainId(pub u64);

impl ChainId {
    /// The underlying numeric id.
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl From<u64> for ChainId {
    fn from(v: u64) -> Self {
        Self(v)
    }
}

impl fmt::Display for ChainId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for ChainId {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>()
            .map(ChainId)
            .map_err(|e| DomainParseError::new("chain id", s, e))
    }
}

impl Serialize for ChainId {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(self.0)
    }
}

/// A 20-byte EVM address. Parsed/validated on construction; serialized as lowercase `0x…`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Address(pub AlloyAddress);

impl Address {
    /// The underlying alloy address.
    pub const fn inner(&self) -> AlloyAddress {
        self.0
    }
}

impl From<AlloyAddress> for Address {
    fn from(a: AlloyAddress) -> Self {
        Self(a)
    }
}

impl FromStr for Address {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        AlloyAddress::from_str(s)
            .map(Address)
            .map_err(|e| DomainParseError::new("address", s, e))
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Lowercase hex; the UI matches addresses case-insensitively.
        write!(f, "{:#x}", self.0)
    }
}

impl Serialize for Address {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// An amount in wei (or, for fee fields, gas units). Serialized as a decimal string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Wei(pub U256);

impl Wei {
    /// The underlying integer.
    pub const fn get(self) -> U256 {
        self.0
    }

    /// Format as a human-readable ether string (18 decimals).
    pub fn to_ether_string(self) -> String {
        format_ether(self.0)
    }

    /// Format with an arbitrary number of decimals.
    pub fn to_units_string(self, decimals: u8) -> Result<String, UnitsError> {
        format_units(self.0, decimals)
    }
}

impl From<U256> for Wei {
    fn from(v: U256) -> Self {
        Self(v)
    }
}

impl FromStr for Wei {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        U256::from_str(s)
            .map(Wei)
            .map_err(|e| DomainParseError::new("wei", s, e))
    }
}

impl fmt::Display for Wei {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for Wei {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

/// EVM calldata. Serialized as `0x`-prefixed hex.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallData(pub Bytes);

impl FromStr for CallData {
    type Err = DomainParseError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Bytes::from_str(s)
            .map(CallData)
            .map_err(|e| DomainParseError::new("calldata", s, e))
    }
}

impl fmt::Display for CallData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0) // alloy Bytes Display is "0x…"
    }
}

impl Serialize for CallData {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

/// Number of decimal places a token/currency uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Decimals(pub u8);

impl Decimals {
    /// The raw decimal count.
    pub const fn get(self) -> u8 {
        self.0
    }
}

impl fmt::Display for Decimals {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A currency or token ticker symbol (e.g. `ETH`, `USDC`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct Symbol(String);

impl Symbol {
    /// Wrap a symbol string.
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    /// The symbol as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// True if the contract reported no symbol.
    pub const fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Display for Symbol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A token amount that knows its own scale: a raw integer plus the token's [`Decimals`]. It can
/// render itself as a human-readable decimal string without a separate, redundant `String` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenAmount {
    raw: U256,
    decimals: Decimals,
}

impl TokenAmount {
    /// Build from a raw integer and a decimal scale.
    pub const fn new(raw: U256, decimals: Decimals) -> Self {
        Self { raw, decimals }
    }

    /// The raw, unscaled integer value.
    pub const fn raw(self) -> U256 {
        self.raw
    }

    /// The token's decimal scale.
    pub const fn decimals(self) -> Decimals {
        self.decimals
    }

    /// Render as a human-readable decimal string (`raw / 10^decimals`).
    pub fn to_decimal_string(self) -> String {
        format_units(self.raw, self.decimals.0).unwrap_or_else(|_| self.raw.to_string())
    }
}

impl fmt::Display for TokenAmount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_decimal_string())
    }
}

/// Error parsing a string into a domain type.
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
            input: input.to_owned(),
            source: source.to_string(),
        }
    }
}

impl fmt::Display for DomainParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid {} '{}': {}", self.kind, self.input, self.source)
    }
}

impl std::error::Error for DomainParseError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_roundtrips_lowercase() {
        let a: Address = "0x52908400098527886E0F7030069857D2E4169EE7"
            .parse()
            .unwrap();
        assert_eq!(
            serde_json::to_value(a).unwrap(),
            serde_json::json!("0x52908400098527886e0f7030069857d2e4169ee7")
        );
    }

    #[test]
    fn wei_serializes_decimal() {
        let w: Wei = "1000000000000000000".parse().unwrap();
        assert_eq!(
            serde_json::to_value(w).unwrap(),
            serde_json::json!("1000000000000000000")
        );
        assert_eq!(w.to_ether_string(), "1.000000000000000000");
    }

    #[test]
    fn chain_id_serializes_number() {
        assert_eq!(
            serde_json::to_value(ChainId(137)).unwrap(),
            serde_json::json!(137)
        );
    }

    #[test]
    fn calldata_serializes_hex() {
        let d: CallData = "0xdeadbeef".parse().unwrap();
        assert_eq!(
            serde_json::to_value(&d).unwrap(),
            serde_json::json!("0xdeadbeef")
        );
    }

    #[test]
    fn bad_address_is_rejected() {
        assert!("0x1234".parse::<Address>().is_err());
    }
}
