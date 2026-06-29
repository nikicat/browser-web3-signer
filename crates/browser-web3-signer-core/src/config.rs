//! Shared configuration helpers and the [`Port`] / [`BindPort`] domain types
//! (ported from `config.ts`).

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
        Port(port)
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
        let n: u16 = s.parse().map_err(|_| format!("invalid port {s:?}"))?;
        Port::try_new(n).ok_or_else(|| "port must be non-zero".to_string())
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
}
