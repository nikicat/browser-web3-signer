//! Built-in Bitcoin network configuration and environment overrides.

use std::num::NonZeroU16;

use browser_web3_signer_core::{Port, port_from_env};

use crate::domain::BtcNetwork;

/// Environment variable for the HTTP bridge port (preferred/daemon port).
pub const PORT_ENV: &str = "BROWSER_WEB3_BTC_PORT";
/// Environment variable for the default network.
pub const NETWORK_ENV: &str = "BROWSER_WEB3_BTC_NETWORK";
/// Default HTTP bridge port for Bitcoin (next to EVM's 3847 and TRON's 3848).
pub const DEFAULT_BTC_PORT: Port = Port::new(match NonZeroU16::new(3849) {
    Some(n) => n,
    None => unreachable!(),
});

/// The preferred HTTP bridge port from [`PORT_ENV`], falling back to 3849.
pub fn port() -> Port {
    port_from_env(PORT_ENV, DEFAULT_BTC_PORT)
}

/// The default network from [`NETWORK_ENV`], falling back to mainnet.
pub fn default_network() -> BtcNetwork {
    std::env::var(NETWORK_ENV)
        .ok()
        .and_then(|v| v.parse::<BtcNetwork>().ok())
        .unwrap_or(BtcNetwork::Mainnet)
}

/// The mempool.space transaction URL base for a network; none for a local regtest chain.
pub const fn block_explorer(network: BtcNetwork) -> Option<&'static str> {
    match network {
        BtcNetwork::Mainnet => Some("https://mempool.space/tx/"),
        BtcNetwork::Testnet => Some("https://mempool.space/testnet/tx/"),
        BtcNetwork::Testnet4 => Some("https://mempool.space/testnet4/tx/"),
        BtcNetwork::Signet => Some("https://mempool.space/signet/tx/"),
        BtcNetwork::Regtest => None,
    }
}
