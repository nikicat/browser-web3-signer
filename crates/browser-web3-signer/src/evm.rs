//! EVM subcommands: one-shot wallet operations.

use std::path::PathBuf;

use anyhow::{Context, Result};
use browser_web3_signer_core::{BindPort, BrowserChoice, Url};
use browser_web3_signer_evm::{
    Address, CallData, ChainId, ConnectParams, EvmRequest, EvmSigner, SendTransactionParams,
    Signature, TxHash, TypedData, Wei, config,
};
use clap::Subcommand;
use serde_json::json;

use crate::{CliContext, OpenMode, OutputFormat, flow, output};

/// EVM subcommands.
#[derive(Debug, Subcommand)]
pub(crate) enum EvmCommand {
    /// Connect a wallet and print its address.
    Connect {
        /// Chain id (defaults to env / 1).
        #[arg(long)]
        chain: Option<ChainId>,
        /// Expected wallet address; the UI rejects a mismatch.
        #[arg(long)]
        address: Option<Address>,
        /// RPC URL for a custom/non-built-in chain (e.g. a local anvil node). The approval page
        /// adds the chain to the wallet via `wallet_addEthereumChain` using this endpoint.
        #[arg(long = "rpc-url")]
        rpc_url: Option<Url>,
        /// Display name for the custom chain (used with `--rpc-url`).
        #[arg(long = "chain-name")]
        chain_name: Option<String>,
    },
    /// Send ETH or call a contract.
    SendTransaction {
        /// Recipient / contract address (required).
        #[arg(long)]
        to: Address,
        /// Expected `from` address (UI rejects on mismatch).
        #[arg(long)]
        from: Option<Address>,
        /// Value in wei.
        #[arg(long)]
        value: Option<Wei>,
        /// Calldata (0x-hex).
        #[arg(long)]
        data: Option<CallData>,
        /// Chain id.
        #[arg(long)]
        chain: Option<ChainId>,
        /// Gas limit.
        #[arg(long = "gas-limit")]
        gas_limit: Option<Wei>,
        /// EIP-1559 max fee per gas (wei).
        #[arg(long = "max-fee-per-gas")]
        max_fee_per_gas: Option<Wei>,
        /// EIP-1559 max priority fee per gas (wei).
        #[arg(long = "max-priority-fee-per-gas")]
        max_priority_fee_per_gas: Option<Wei>,
    },
    /// `personal_sign` an arbitrary message.
    SignMessage {
        /// The message to sign.
        #[arg(long)]
        message: String,
        /// Address to sign with (defaults to the connected account).
        #[arg(long)]
        address: Option<Address>,
        /// Chain id.
        #[arg(long)]
        chain: Option<ChainId>,
    },
    /// Sign EIP-712 typed data from a JSON file (`{domain, types, primaryType, message}`).
    SignTypedData {
        /// Path to the typed-data JSON file.
        #[arg(long)]
        file: PathBuf,
        /// Address to sign with.
        #[arg(long)]
        address: Option<Address>,
        /// Chain id.
        #[arg(long)]
        chain: Option<ChainId>,
    },
}

/// Typed-data file shape (`{domain, types, primaryType, message}`).
#[derive(serde::Deserialize)]
struct TypedDataFile {
    domain: serde_json::Value,
    types: serde_json::Value,
    #[serde(rename = "primaryType")]
    primary_type: String,
    message: serde_json::Value,
}

/// Owns the signer plus presentation context for one CLI invocation, so each subcommand is a
/// method rather than a free function threading `(&signer, &ctx)` everywhere. (The signer stays
/// in the library crate and is presentation-free; the stdout/JSON formatting lives here.)
struct EvmCli {
    signer: EvmSigner,
    ctx: CliContext,
}

impl EvmCli {
    fn new(ctx: CliContext) -> Self {
        let browser = match &ctx.open {
            OpenMode::Named(name) => BrowserChoice::Named(name.clone()),
            _ => BrowserChoice::Default,
        };
        let signer = EvmSigner::new(
            BindPort::Preferred(config::port()),
            config::default_chain_id(),
            browser,
        );
        Self { signer, ctx }
    }

    /// The effective chain id (explicit flag, else the signer default).
    fn chain_or_default(&self, chain: Option<ChainId>) -> ChainId {
        chain.unwrap_or_else(|| self.signer.default_chain_id())
    }

    /// Register the request, surface the approval URL, open the browser unless `--print`, await
    /// the wallet's response, and parse it into the expected domain type `T`. The type the caller
    /// binds the result to documents what the operation returns.
    async fn approve<T>(&self, request: EvmRequest, what: &str) -> Result<T>
    where
        T: std::str::FromStr,
        <T as std::str::FromStr>::Err: std::fmt::Display,
    {
        let prepared = self.signer.prepare(request).await?;
        flow::await_signed(prepared, &self.ctx.open, &self.signer, what).await
    }

    async fn connect(
        &self,
        chain: Option<ChainId>,
        address: Option<Address>,
        rpc_url: Option<Url>,
        chain_name: Option<String>,
    ) -> Result<()> {
        let req = EvmRequest::connect_with(ConnectParams {
            chain_id: Some(self.chain_or_default(chain)),
            address,
            rpc_url,
            chain_name,
        });
        let addr: Address = self.approve(req, "address").await?;
        match self.ctx.output {
            OutputFormat::Text => println!("Connected: {addr}"),
            OutputFormat::Json => output::json(&json!({ "address": addr.to_string() })),
        }
        Ok(())
    }

    async fn send_transaction(
        &self,
        chain_id: ChainId,
        params: SendTransactionParams,
    ) -> Result<()> {
        let req = EvmRequest::send_transaction(params);
        let hash: TxHash = self.approve(req, "tx hash").await?;
        let explorer = config::chain_config(chain_id)
            .and_then(|c| c.block_explorer)
            .and_then(|base| Url::parse(&format!("{base}/tx/{hash}")).ok());
        match self.ctx.output {
            OutputFormat::Text => {
                println!("Tx hash: {hash}");
                if let Some(url) = &explorer {
                    println!("Explorer: {url}");
                }
            }
            OutputFormat::Json => output::json(&json!({
                "txHash": hash.to_string(),
                "explorer": explorer,
            })),
        }
        Ok(())
    }

    async fn sign_typed_data(
        &self,
        file: &std::path::Path,
        address: Option<Address>,
        chain: Option<ChainId>,
    ) -> Result<()> {
        let contents = std::fs::read_to_string(file)
            .with_context(|| format!("reading typed-data file {}", file.display()))?;
        let parsed: TypedDataFile =
            serde_json::from_str(&contents).context("parsing typed-data JSON")?;
        let typed = TypedData {
            domain: parsed.domain,
            types: parsed.types,
            primary_type: parsed.primary_type,
            message: parsed.message,
        };
        let req = EvmRequest::sign_typed_data(typed, address, Some(self.chain_or_default(chain)));
        self.sign(req).await
    }

    /// Shared tail for `sign_message` / `sign_typed_data`: await a signature and emit it.
    async fn sign(&self, req: EvmRequest) -> Result<()> {
        let sig: Signature = self.approve(req, "signature").await?;
        match self.ctx.output {
            OutputFormat::Text => println!("Signature: {sig}"),
            OutputFormat::Json => output::json(&json!({ "signature": sig.to_string() })),
        }
        Ok(())
    }
}

/// Run an EVM subcommand by dispatching to the matching [`EvmCli`] method.
pub(crate) async fn run(cmd: EvmCommand, ctx: CliContext) -> Result<()> {
    let cli = EvmCli::new(ctx);
    match cmd {
        EvmCommand::Connect {
            chain,
            address,
            rpc_url,
            chain_name,
        } => cli.connect(chain, address, rpc_url, chain_name).await,
        EvmCommand::SendTransaction {
            to,
            from,
            value,
            data,
            chain,
            gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
        } => {
            let chain_id = cli.chain_or_default(chain);
            let params = SendTransactionParams {
                to,
                from,
                value,
                data,
                chain_id: Some(chain_id),
                gas_limit,
                max_fee_per_gas,
                max_priority_fee_per_gas,
            };
            cli.send_transaction(chain_id, params).await
        }
        EvmCommand::SignMessage {
            message,
            address,
            chain,
        } => {
            let req = EvmRequest::sign_message(message, address, Some(cli.chain_or_default(chain)));
            cli.sign(req).await
        }
        EvmCommand::SignTypedData {
            file,
            address,
            chain,
        } => cli.sign_typed_data(&file, address, chain).await,
    }
}
