//! EVM subcommands: one-shot wallet operations and read-only balance queries.

use std::path::PathBuf;

use anyhow::{Context, Result};
use browser_web3_signer_core::{BindPort, BrowserChoice};
use browser_web3_signer_evm::{
    Address, CallData, ChainId, EvmRequest, EvmSigner, SendTransactionParams, Signature, TxHash,
    TypedData, Wei, config,
};
use clap::Subcommand;
use serde_json::json;

use crate::{CliContext, OpenMode, OutputFormat, flow, output};

/// EVM subcommands.
#[derive(Debug, Subcommand)]
pub enum EvmCommand {
    /// Connect a wallet and print its address.
    Connect {
        /// Chain id (defaults to env / 1).
        #[arg(long)]
        chain: Option<ChainId>,
        /// Expected wallet address; the UI rejects a mismatch.
        #[arg(long)]
        address: Option<Address>,
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
    /// Read the native balance (no browser).
    GetBalance {
        /// Address to query.
        #[arg(long)]
        address: Address,
        /// Chain id.
        #[arg(long)]
        chain: Option<ChainId>,
    },
    /// Read an ERC-20 token balance (no browser).
    GetTokenBalance {
        /// Token contract address.
        #[arg(long)]
        token: Address,
        /// Holder address to query.
        #[arg(long)]
        address: Address,
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

fn make_signer(ctx: &CliContext) -> EvmSigner {
    let browser = match &ctx.open {
        OpenMode::Named(name) => BrowserChoice::Named(name.clone()),
        _ => BrowserChoice::Default,
    };
    EvmSigner::new(
        BindPort::Preferred(config::port()),
        config::default_chain_id(),
        browser,
    )
}

/// Register the request, surface the approval URL, open the browser unless `--print`, await the
/// wallet's response, and parse it into the expected domain type `T` (e.g. [`Address`],
/// [`TxHash`], [`Signature`]). The type the caller binds the result to *is* the documentation of
/// what this returns — there is no untyped intermediate string at the call site.
async fn approve<T>(
    signer: &EvmSigner,
    ctx: &CliContext,
    request: EvmRequest,
    what: &str,
) -> Result<T>
where
    T: std::str::FromStr,
    <T as std::str::FromStr>::Err: std::fmt::Display,
{
    let prepared = signer.prepare(request).await?;
    flow::await_signed(prepared, &ctx.open, signer, what).await
}

/// Resolve the effective chain id (explicit flag, else the signer default).
fn chain_or_default(signer: &EvmSigner, chain: Option<ChainId>) -> ChainId {
    chain.unwrap_or(signer.default_chain_id())
}

/// Run an EVM subcommand.
pub async fn run(cmd: EvmCommand, ctx: CliContext) -> Result<()> {
    let signer = make_signer(&ctx);
    match cmd {
        EvmCommand::Connect { chain, address } => {
            let req = EvmRequest::connect(Some(chain_or_default(&signer, chain)), address);
            let addr: Address = approve(&signer, &ctx, req, "address").await?;
            match ctx.output {
                OutputFormat::Text => println!("Connected: {addr}"),
                OutputFormat::Json => output::json(&json!({ "address": addr.to_string() })),
            }
        }
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
            let chain_id = chain_or_default(&signer, chain);
            let req = EvmRequest::send_transaction(SendTransactionParams {
                to,
                from,
                value,
                data,
                chain_id: Some(chain_id),
                gas_limit,
                max_fee_per_gas,
                max_priority_fee_per_gas,
            });
            let hash: TxHash = approve(&signer, &ctx, req, "tx hash").await?;
            let explorer = config::chain_config(chain_id)
                .and_then(|c| c.block_explorer)
                .map(|base| format!("{base}/tx/{hash}"));
            match ctx.output {
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
        }
        EvmCommand::SignMessage {
            message,
            address,
            chain,
        } => {
            let req =
                EvmRequest::sign_message(message, address, Some(chain_or_default(&signer, chain)));
            let sig: Signature = approve(&signer, &ctx, req, "signature").await?;
            emit_signature(&ctx, &sig);
        }
        EvmCommand::SignTypedData {
            file,
            address,
            chain,
        } => {
            let contents = std::fs::read_to_string(&file)
                .with_context(|| format!("reading typed-data file {}", file.display()))?;
            let parsed: TypedDataFile =
                serde_json::from_str(&contents).context("parsing typed-data JSON")?;
            let typed = TypedData {
                domain: parsed.domain,
                types: parsed.types,
                primary_type: parsed.primary_type,
                message: parsed.message,
            };
            let req =
                EvmRequest::sign_typed_data(typed, address, Some(chain_or_default(&signer, chain)));
            let sig: Signature = approve(&signer, &ctx, req, "signature").await?;
            emit_signature(&ctx, &sig);
        }
        EvmCommand::GetBalance { address, chain } => {
            let res = signer.get_balance(address, chain).await?;
            match ctx.output {
                OutputFormat::Text => {
                    println!("Balance: {} {}", res.to_decimal_string(), res.symbol);
                    println!("Wei:     {}", res.amount);
                }
                OutputFormat::Json => output::json(&json!({
                    "balance": res.to_decimal_string(),
                    "wei": res.amount.to_string(),
                    "symbol": res.symbol.to_string(),
                })),
            }
        }
        EvmCommand::GetTokenBalance {
            token,
            address,
            chain,
        } => {
            let res = signer.get_token_balance(token, address, chain).await?;
            match ctx.output {
                OutputFormat::Text => {
                    println!("Balance: {} {}", res.amount.to_decimal_string(), res.symbol);
                }
                OutputFormat::Json => output::json(&json!({
                    "balance": res.amount.to_decimal_string(),
                    "raw": res.amount.raw().to_string(),
                    "symbol": res.symbol.to_string(),
                    "decimals": res.amount.decimals().get(),
                })),
            }
        }
    }
    Ok(())
}

fn emit_signature(ctx: &CliContext, sig: &Signature) {
    match ctx.output {
        OutputFormat::Text => println!("Signature: {sig}"),
        OutputFormat::Json => output::json(&json!({ "signature": sig.to_string() })),
    }
}
