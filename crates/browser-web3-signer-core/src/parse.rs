//! Parsing shared by every chain crate: the error a domain type's `FromStr` returns, and the
//! field readers each chain's `Request::from_json` builds its request from.

use std::fmt;
use std::str::FromStr;

/// Error parsing a string into a domain type.
#[derive(Debug)]
pub struct DomainParseError {
    kind: &'static str,
    input: String,
    source: String,
}

impl DomainParseError {
    /// A failed parse of `input` as a `kind` (e.g. `"tron address"`), with the reason.
    pub fn new(kind: &'static str, input: &str, source: impl fmt::Display) -> Self {
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

/// Read a required string field, or a "missing/!string" reason.
pub fn str_field<'a>(body: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    body.get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("missing or non-string field '{key}'"))
}

/// Parse a required string field into a domain type `T`, mapping failures to a reason.
pub fn req_parsed<T>(body: &serde_json::Value, key: &str) -> Result<T, String>
where
    T: FromStr,
    <T as FromStr>::Err: fmt::Display,
{
    str_field(body, key)?
        .parse::<T>()
        .map_err(|e| format!("invalid '{key}': {e}"))
}

/// Parse an optional string field into a domain type `T`; `None` if absent, error if present but
/// unparseable.
pub fn opt_parsed<T>(body: &serde_json::Value, key: &str) -> Result<Option<T>, String>
where
    T: FromStr,
    <T as FromStr>::Err: fmt::Display,
{
    body.get(key)
        .and_then(serde_json::Value::as_str)
        .map(|s| s.parse::<T>().map_err(|e| format!("invalid '{key}': {e}")))
        .transpose()
}
