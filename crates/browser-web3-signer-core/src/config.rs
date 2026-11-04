//! Shared configuration helpers and the [`Port`] / [`BindPort`] domain types
//! (ported from `config.ts`).

use std::env::VarError;
use std::fmt;
use std::num::NonZeroU16;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// A TCP port (always non-zero — "port 0" is not a real port but a *request* for an ephemeral
/// one, which is modelled separately by [`BindPort::Ephemeral`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Port(NonZeroU16);

impl Port {
    /// Construct from a non-zero port number.
    pub const fn new(port: NonZeroU16) -> Self {
        Self(port)
    }

    /// Construct from a raw `u16`, returning `None` for `0`.
    pub fn try_new(port: u16) -> Option<Self> {
        NonZeroU16::new(port).map(Port)
    }

    /// The numeric port.
    pub const fn get(self) -> u16 {
        self.0.get()
    }
}

impl fmt::Display for Port {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.get())
    }
}

impl FromStr for Port {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let n: u16 = s.parse().map_err(|e| format!("invalid port {s:?}: {e}"))?;
        Self::try_new(n).ok_or_else(|| "port must be non-zero".to_owned())
    }
}

/// How the HTTP bridge should choose its bind port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindPort {
    /// Bind this preferred port; if it is already in use, fall back to an ephemeral port.
    /// Keeps the browser origin (`127.0.0.1:<port>`) stable across one-shot invocations.
    Preferred(Port),
    /// Always bind an OS-assigned ephemeral port (never collides; new origin each time).
    Ephemeral,
}

/// Default HTTP bridge port (EVM). TRON defaults to 3848.
pub const DEFAULT_PORT: Port = Port(NonZeroU16::new(3847).unwrap());

/// Read a [`Port`] from the given environment variable, falling back to `default_port`.
/// Invalid or zero values fall back to the default.
pub fn port_from_env(env_name: &str, default_port: Port) -> Port {
    std::env::var(env_name)
        .ok()
        .and_then(|v| v.parse::<Port>().ok())
        .unwrap_or(default_port)
}

/// Reads an `A` from the environment variable `env_name`.
///
/// Returns `None` when the variable is unset or empty. Errors when the value is not Unicode or
/// does not parse as an `A`. The error names the variable.
pub(crate) fn account_from_env<A>(env_name: &str) -> Result<Option<A>, String>
where
    A: FromStr,
    A::Err: fmt::Display,
{
    let account = match std::env::var(env_name) {
        Ok(value) => parse_account(&value),
        Err(VarError::NotPresent) => Ok(None),
        Err(e @ VarError::NotUnicode(_)) => Err(e.to_string()),
    };
    account.map_err(|e| format!("invalid {env_name}: {e}"))
}

/// Parses an account variable's value, empty meaning no account. Errors with the parse reason.
fn parse_account<A>(value: &str) -> Result<Option<A>, String>
where
    A: FromStr,
    A::Err: fmt::Display,
{
    if value.is_empty() {
        return Ok(None);
    }
    value.parse().map(Some).map_err(|e: A::Err| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_rejects_zero() {
        assert!(Port::try_new(0).is_none());
        assert!("0".parse::<Port>().is_err());
        assert_eq!("3847".parse::<Port>().unwrap().get(), 3847);
    }

    #[test]
    fn port_serializes_as_number() {
        let p = Port::try_new(3847).unwrap();
        assert_eq!(serde_json::to_value(p).unwrap(), serde_json::json!(3847));
        let back: Port = serde_json::from_value(serde_json::json!(3847)).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn account_variable_is_optional_and_parsed() {
        // `Port` stands in for a chain's address type: any `FromStr` reads the same way.
        assert_eq!(
            account_from_env::<Port>("BROWSER_WEB3_TEST_UNSET_ACCOUNT"),
            Ok(None)
        );
        assert_eq!(parse_account::<Port>(""), Ok(None));
        assert_eq!(parse_account::<Port>("3847"), Ok(Port::try_new(3847)));
        assert_eq!(
            parse_account::<Port>("nope"),
            Err("nope".parse::<Port>().unwrap_err())
        );
    }
}
