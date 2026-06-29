//! Chain-agnostic byte-array domain types shared by EVM and TRON.
//!
//! A 32-byte transaction hash and an ECDSA signature are identical across both (secp256k1/keccak
//! chains), so these representations live here; only address encoding is chain-specific. Values
//! are stored as raw bytes (not validated strings). Hex is offered both with and without the `0x`
//! prefix so each chain can render in its conventional form (EVM uses `0x…`, TRON omits it).

use std::fmt;
use std::str::FromStr;

use serde::{Serialize, Serializer};

/// An arbitrary hex byte blob — EVM calldata or a TRON memo. Stored as raw bytes; parsed from /
/// serialized to `0x`-prefixed hex (the form the wallet UIs expect).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct HexData(Vec<u8>);

impl HexData {
    /// The raw bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// True if there are no bytes.
    pub const fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `0x`-prefixed lowercase hex.
    pub fn to_hex_prefixed(&self) -> String {
        format!("0x{}", hex::encode(&self.0))
    }
}

impl FromStr for HexData {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let raw = s.strip_prefix("0x").unwrap_or(s);
        hex::decode(raw)
            .map(HexData)
            .map_err(|e| format!("invalid hex data {s:?}: {e}"))
    }
}

impl fmt::Display for HexData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "0x{}", hex::encode(&self.0))
    }
}

impl Serialize for HexData {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex_prefixed())
    }
}

/// A 32-byte transaction hash (a.k.a. tx id).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TxHash([u8; 32]);

impl TxHash {
    /// The raw 32 bytes.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Lowercase hex without a `0x` prefix (TRON / tronscan convention).
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Lowercase hex with a `0x` prefix (EVM / etherscan convention).
    pub fn to_hex_prefixed(&self) -> String {
        format!("0x{}", hex::encode(self.0))
    }
}

impl FromStr for TxHash {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let raw = s.strip_prefix("0x").unwrap_or(s);
        let bytes = hex::decode(raw).map_err(|e| format!("invalid tx hash {s:?}: {e}"))?;
        let bytes: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|e| format!("invalid tx hash {s:?}: expected 32 bytes ({e})"))?;
        Ok(Self(bytes))
    }
}

impl fmt::Display for TxHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "0x{}", hex::encode(self.0))
    }
}

/// An ECDSA signature (typically 65 bytes, but stored as variable-length bytes to tolerate
/// wallet variance).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Signature(Vec<u8>);

impl Signature {
    /// The raw signature bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// Lowercase hex with a `0x` prefix.
    pub fn to_hex_prefixed(&self) -> String {
        format!("0x{}", hex::encode(&self.0))
    }
}

impl FromStr for Signature {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let raw = s.strip_prefix("0x").unwrap_or(s);
        let bytes = hex::decode(raw).map_err(|e| format!("invalid signature {s:?}: {e}"))?;
        if bytes.is_empty() {
            return Err(format!("invalid signature {s:?}: empty"));
        }
        Ok(Self(bytes))
    }
}

impl fmt::Display for Signature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "0x{}", hex::encode(&self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tx_hash_parses_with_and_without_prefix() {
        let a: TxHash = "0xabababababababababababababababababababababababababababababababab"
            .parse()
            .unwrap();
        let b: TxHash = "abababababababababababababababababababababababababababababababab"
            .parse()
            .unwrap();
        assert_eq!(a, b);
        assert_eq!(a.to_hex().len(), 64);
        assert!(a.to_hex_prefixed().starts_with("0x"));
        assert!("0x12".parse::<TxHash>().is_err());
    }

    #[test]
    fn signature_roundtrips_hex() {
        let s: Signature = "0xdeadbeef".parse().unwrap();
        assert_eq!(s.to_string(), "0xdeadbeef");
        assert_eq!(s.as_bytes(), &[0xde, 0xad, 0xbe, 0xef]);
        assert!("0x".parse::<Signature>().is_err());
    }
}
