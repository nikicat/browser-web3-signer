//! Built-in TRON network configuration and environment overrides (ported from
//! `browser-tron-signer/src/config.ts`).

use std::num::NonZeroU16;

use browser_web3_signer_core::{Port, port_from_env};

use crate::domain::TronNetwork;

/// Environment variable for the HTTP bridge port (preferred/daemon port).
pub const PORT_ENV: &str = "BROWSER_WEB3_TRON_PORT";
/// Environment variable for the default network.
pub const NETWORK_ENV: &str = "BROWSER_WEB3_TRON_NETWORK";
/// Default HTTP bridge port for TRON (separate from EVM's 3847).
pub const DEFAULT_TRON_PORT: Port = Port::new(match NonZeroU16::new(3848) {
    Some(n) => n,
    None => unreachable!(),
});

/// Configuration for a supported TRON network.
#[derive(Debug, Clone)]
pub struct NetworkConfig {
    /// Network id.
    pub id: TronNetwork,
    /// Human-readable name.
    pub name: &'static str,
    /// Block explorer base URL.
    pub block_explorer: &'static str,
    /// Native currency symbol.
    pub symbol: &'static str,
    /// Native currency decimals (TRX = 6).
    pub decimals: u8,
}

/// The preferred HTTP bridge port from [`PORT_ENV`], falling back to 3848.
pub fn port() -> Port {
    port_from_env(PORT_ENV, DEFAULT_TRON_PORT)
}

/// The default network from [`NETWORK_ENV`], falling back to mainnet.
pub fn default_network() -> TronNetwork {
    std::env::var(NETWORK_ENV)
        .ok()
        .and_then(|v| v.parse::<TronNetwork>().ok())
        .unwrap_or(TronNetwork::Mainnet)
}

/// All built-in networks.
pub const NETWORKS: &[NetworkConfig] = &[
    NetworkConfig {
        id: TronNetwork::Mainnet,
        name: "Tron Mainnet",
        block_explorer: "https://tronscan.org",
        symbol: "TRX",
        decimals: 6,
    },
    NetworkConfig {
        id: TronNetwork::Shasta,
        name: "Shasta Testnet",
        block_explorer: "https://shasta.tronscan.org",
        symbol: "TRX",
        decimals: 6,
    },
    NetworkConfig {
        id: TronNetwork::Nile,
        name: "Nile Testnet",
        block_explorer: "https://nile.tronscan.org",
        symbol: "TRX",
        decimals: 6,
    },
];

/// Look up a network config by id.
pub fn network_config(network: TronNetwork) -> Option<&'static NetworkConfig> {
    NETWORKS.iter().find(|n| n.id == network)
}
