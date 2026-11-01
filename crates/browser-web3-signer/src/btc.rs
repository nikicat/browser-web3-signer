//! Bitcoin subcommands: one-shot wallet operations via Unisat.

use std::path::PathBuf;

use anyhow::{Context, Result};
use browser_web3_signer_btc::{
    BindPort, BtcNetwork, BtcRequest, BtcSigner, MessageProtocol, MessageSignature, PsbtData,
    SatPerVb, Sats, SendTransferParams, SignMessageParams, SignPsbtParams, Txid, UncheckedAddress,
    Url, block_explorer, config, parse_address, parse_signed_psbt,
};
use clap::{ArgGroup, Subcommand};
use serde_json::json;

use crate::{CliContext, OutputFormat, flow, output};

/// Bitcoin subcommands.
#[derive(Debug, Subcommand)]
pub(crate) enum BtcCommand {
    /// Connect the wallet and print its address.
    Connect {
        /// Network (mainnet|testnet|testnet4|signet|regtest; defaults to env / mainnet).
        #[arg(long)]
        network: Option<BtcNetwork>,
        /// Expected wallet address; the UI rejects a mismatch.
        #[arg(long)]
        address: Option<UncheckedAddress>,
    },
    /// Pay one address. The wallet picks coins and the fee, signs and broadcasts.
    Send {
        /// Recipient address.
        #[arg(long)]
        to: UncheckedAddress,
        /// Amount in sats (1 BTC = 100,000,000 sats).
        #[arg(long)]
        amount: Sats,
        /// Expected sender address (UI rejects on mismatch).
        #[arg(long)]
        from: Option<UncheckedAddress>,
        /// Fee-rate hint in sat/vB.
        #[arg(long = "fee-rate")]
        fee_rate: Option<SatPerVb>,
        /// Network.
        #[arg(long)]
        network: Option<BtcNetwork>,
    },
    /// Sign a PSBT and print it (hex). The signed PSBT is checked to be for the same transaction.
    #[command(group(ArgGroup::new("input").required(true).args(["psbt", "psbt_file"])))]
    SignPsbt {
        /// The PSBT, hex or base64.
        #[arg(long)]
        psbt: Option<PsbtData>,
        /// Read the PSBT (hex or base64) from a file.
        #[arg(long = "psbt-file")]
        psbt_file: Option<PathBuf>,
        /// Input index to sign (repeatable). Default: every input the wallet's account owns.
        #[arg(long = "sign-input")]
        sign_inputs: Vec<u32>,
        /// Finalize the signed inputs.
        #[arg(long)]
        finalize: bool,
        /// Broadcast through the wallet after signing (implies --finalize).
        #[arg(long)]
        broadcast: bool,
        /// Expected signer address (UI rejects on mismatch).
        #[arg(long)]
        from: Option<UncheckedAddress>,
        /// Network.
        #[arg(long)]
        network: Option<BtcNetwork>,
    },
    /// Sign a text message (BIP-322 by default).
    SignMessage {
        /// The message to sign.
        #[arg(long)]
        message: String,
        /// Address to sign with.
        #[arg(long)]
        address: Option<UncheckedAddress>,
        /// Signature scheme (bip322|ecdsa).
        #[arg(long, default_value = "bip322")]
        protocol: MessageProtocol,
        /// Network.
        #[arg(long)]
        network: Option<BtcNetwork>,
    },
}

/// Owns the Bitcoin signer plus presentation context for one CLI invocation; each subcommand is
/// a method rather than a free function threading `(&signer, &ctx)`.
struct BtcCli {
    signer: BtcSigner,
    ctx: CliContext,
}

impl BtcCli {
    fn new(ctx: CliContext) -> Self {
        let signer = BtcSigner::new(
            BindPort::Preferred(config::port()),
            config::default_network(),
            ctx.open.browser_choice(),
        );
        Self { signer, ctx }
    }

    /// The effective network (explicit flag, else the signer default).
    fn network_or_default(&self, network: Option<BtcNetwork>) -> BtcNetwork {
        network.unwrap_or_else(|| self.signer.default_network())
    }

    /// Register, surface the URL, open unless `--print`, and await the raw wallet response.
    async fn approve(&self, request: BtcRequest) -> Result<String> {
        let prepared = self.signer.prepare(request).await?;
        flow::await_raw(prepared, &self.ctx.open, &self.signer).await
    }

    async fn connect(
        &self,
        network: Option<BtcNetwork>,
        address: Option<UncheckedAddress>,
    ) -> Result<()> {
        let network = self.network_or_default(network);
        let raw = self.approve(BtcRequest::connect(network, address)?).await?;
        let addr = parse_address(&raw, network)?;
        match self.ctx.output {
            OutputFormat::Text => println!("Connected: {addr}"),
            OutputFormat::Json => output::json(&json!({ "address": addr.to_string() })),
        }
        Ok(())
    }

    async fn send(&self, params: SendTransferParams) -> Result<()> {
        let network = params.network;
        let prepared = self
            .signer
            .prepare(BtcRequest::send_transfer(params)?)
            .await?;
        let txid: Txid = flow::await_signed(prepared, &self.ctx.open, &self.signer, "txid").await?;
        let explorer = tx_explorer(network, txid);
        match self.ctx.output {
            OutputFormat::Text => {
                println!("Txid: {txid}");
                if let Some(url) = &explorer {
                    println!("Explorer: {url}");
                }
            }
            OutputFormat::Json => output::json(&json!({
                "txid": txid.to_string(),
                "explorer": explorer,
            })),
        }
        Ok(())
    }

    async fn sign_psbt(&self, params: SignPsbtParams) -> Result<()> {
        let network = params.network;
        let unsigned = params.psbt.clone();
        let tx = &unsigned.as_psbt().unsigned_tx;
        output::progress(format!(
            "Signing PSBT for tx {} ({} inputs, {} outputs)",
            unsigned.unsigned_txid(),
            tx.input.len(),
            tx.output.len()
        ));
        let raw = self.approve(BtcRequest::sign_psbt(params)?).await?;
        let signed = parse_signed_psbt(&unsigned, &raw)?;
        let explorer = signed.txid.and_then(|t| tx_explorer(network, t));
        match self.ctx.output {
            OutputFormat::Text => {
                println!("PSBT: {}", signed.psbt);
                if let Some(txid) = signed.txid {
                    println!("Txid: {txid}");
                }
                if let Some(url) = &explorer {
                    println!("Explorer: {url}");
                }
            }
            OutputFormat::Json => output::json(&json!({
                "psbt": signed.psbt.to_string(),
                "txid": signed.txid.map(|t| t.to_string()),
                "explorer": explorer,
            })),
        }
        Ok(())
    }

    async fn sign_message(&self, params: SignMessageParams) -> Result<()> {
        let prepared = self
            .signer
            .prepare(BtcRequest::sign_message(params)?)
            .await?;
        let sig: MessageSignature =
            flow::await_signed(prepared, &self.ctx.open, &self.signer, "signature").await?;
        match self.ctx.output {
            OutputFormat::Text => println!("Signature: {sig}"),
            OutputFormat::Json => output::json(&json!({ "signature": sig.to_string() })),
        }
        Ok(())
    }
}

/// Build the mempool.space transaction URL for a network + txid.
fn tx_explorer(network: BtcNetwork, txid: Txid) -> Option<Url> {
    Url::parse(&format!("{}{txid}", block_explorer(network)?)).ok()
}

/// Read a PSBT from `--psbt` or `--psbt-file` (clap guarantees exactly one is set).
fn read_psbt(inline: Option<PsbtData>, file: Option<PathBuf>) -> Result<PsbtData> {
    if let Some(psbt) = inline {
        return Ok(psbt);
    }
    let path = file.context("one of --psbt / --psbt-file is required")?;
    let contents = std::fs::read_to_string(&path)
        .with_context(|| format!("reading PSBT file {}", path.display()))?;
    Ok(contents.parse()?)
}

/// Run a Bitcoin subcommand by dispatching to the matching [`BtcCli`] method.
pub(crate) async fn run(cmd: BtcCommand, ctx: CliContext) -> Result<()> {
    let cli = BtcCli::new(ctx);
    match cmd {
        BtcCommand::Connect { network, address } => cli.connect(network, address).await,
        BtcCommand::Send {
            to,
            amount,
            from,
            fee_rate,
            network,
        } => {
            cli.send(SendTransferParams {
                network: cli.network_or_default(network),
                to,
                from,
                amount,
                fee_rate,
            })
            .await
        }
        BtcCommand::SignPsbt {
            psbt,
            psbt_file,
            sign_inputs,
            finalize,
            broadcast,
            from,
            network,
        } => {
            cli.sign_psbt(SignPsbtParams {
                network: cli.network_or_default(network),
                psbt: read_psbt(psbt, psbt_file)?,
                from,
                sign_inputs: (!sign_inputs.is_empty()).then_some(sign_inputs),
                finalize,
                broadcast,
            })
            .await
        }
        BtcCommand::SignMessage {
            message,
            address,
            protocol,
            network,
        } => {
            cli.sign_message(SignMessageParams {
                network: cli.network_or_default(network),
                message,
                address,
                protocol,
            })
            .await
        }
    }
}
