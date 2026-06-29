//! Built-in EVM chain configuration and environment overrides (ported from
//! `browser-evm-signer/src/config.ts`).

use browser_web3_signer_core::{DEFAULT_PORT, Port, port_from_env};

use crate::domain::ChainId;

/// Environment variable for the HTTP bridge port (the preferred/daemon port).
pub const PORT_ENV: &str = "BROWSER_WEB3_EVM_PORT";
/// Environment variable for the default chain id.
pub const CHAIN_ENV: &str = "BROWSER_WEB3_EVM_CHAIN";
/// Default chain id when none is configured (Ethereum mainnet).
pub const DEFAULT_CHAIN_ID: ChainId = ChainId(1);

/// Configuration for a supported EVM chain.
#[derive(Debug, Clone)]
pub struct ChainConfig {
    /// Chain id.
    pub id: ChainId,
    /// Human-readable name.
    pub name: &'static str,
    /// Default JSON-RPC endpoint (used for read-only queries).
    pub rpc_url: &'static str,
    /// Native currency symbol.
    pub symbol: &'static str,
    /// Native currency decimals.
    pub decimals: u8,
    /// Block explorer base URL, if any.
    pub block_explorer: Option<&'static str>,
}

/// The preferred HTTP bridge port from [`PORT_ENV`], falling back to 3847.
pub fn port() -> Port {
    port_from_env(PORT_ENV, DEFAULT_PORT)
}

/// The default chain id from [`CHAIN_ENV`], falling back to [`DEFAULT_CHAIN_ID`].
pub fn default_chain_id() -> ChainId {
    std::env::var(CHAIN_ENV)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .map(ChainId)
        .unwrap_or(DEFAULT_CHAIN_ID)
}

/// All built-in chains.
pub const CHAINS: &[ChainConfig] = &[
    ChainConfig {
        id: ChainId(1),
        name: "Ethereum",
        rpc_url: "https://eth.llamarpc.com",
        symbol: "ETH",
        decimals: 18,
        block_explorer: Some("https://etherscan.io"),
    },
    ChainConfig {
        id: ChainId(11155111),
        name: "Sepolia",
        rpc_url: "https://rpc.sepolia.org",
        symbol: "ETH",
        decimals: 18,
        block_explorer: Some("https://sepolia.etherscan.io"),
    },
    ChainConfig {
        id: ChainId(137),
        name: "Polygon",
        rpc_url: "https://polygon-rpc.com",
        symbol: "MATIC",
        decimals: 18,
        block_explorer: Some("https://polygonscan.com"),
    },
    ChainConfig {
        id: ChainId(42161),
        name: "Arbitrum One",
        rpc_url: "https://arb1.arbitrum.io/rpc",
        symbol: "ETH",
        decimals: 18,
        block_explorer: Some("https://arbiscan.io"),
    },
    ChainConfig {
        id: ChainId(10),
        name: "Optimism",
        rpc_url: "https://mainnet.optimism.io",
        symbol: "ETH",
        decimals: 18,
        block_explorer: Some("https://optimistic.etherscan.io"),
    },
    ChainConfig {
        id: ChainId(8453),
        name: "Base",
        rpc_url: "https://mainnet.base.org",
        symbol: "ETH",
        decimals: 18,
        block_explorer: Some("https://basescan.org"),
    },
    ChainConfig {
        id: ChainId(43114),
        name: "Avalanche",
        rpc_url: "https://api.avax.network/ext/bc/C/rpc",
        symbol: "AVAX",
        decimals: 18,
        block_explorer: Some("https://snowtrace.io"),
    },
    ChainConfig {
        id: ChainId(56),
        name: "BNB Smart Chain",
        rpc_url: "https://bsc-dataseed.binance.org",
        symbol: "BNB",
        decimals: 18,
        block_explorer: Some("https://bscscan.com"),
    },
];

/// Look up a chain by id.
pub fn chain_config(id: ChainId) -> Option<&'static ChainConfig> {
    CHAINS.iter().find(|c| c.id == id)
}

/// The JSON-RPC endpoint for a chain, if known.
pub fn rpc_url(id: ChainId) -> Option<&'static str> {
    chain_config(id).map(|c| c.rpc_url)
}
