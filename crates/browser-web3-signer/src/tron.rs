//! TRON subcommands: one-shot wallet operations and read-only balance queries via TronLink.

use std::path::PathBuf;

use anyhow::{Context, Result};
use browser_web3_signer_core::{BindPort, BrowserChoice, HexData, Signature, TxHash, Url};
use browser_web3_signer_tron::{
    DeployContractParams, EnergyLimit, Percentage, SendTransactionParams, Sun,
    TriggerContractParams, TronAddress, TronNetwork, TronRequest, TronSigner, TypedData, config,
    parse_deploy_result,
};
use clap::Subcommand;
use serde_json::json;

use crate::{CliContext, JsonString, OutputFormat, flow, output};

/// TRON subcommands.
#[derive(Debug, Subcommand)]
pub(crate) enum TronCommand {
    /// Connect TronLink and print its address.
    Connect {
        /// Network (mainnet|shasta|nile; defaults to env / mainnet).
        #[arg(long)]
        network: Option<TronNetwork>,
        /// Expected wallet address; the UI rejects a mismatch.
        #[arg(long)]
        address: Option<TronAddress>,
    },
    /// Send a native TRX transfer.
    SendTransaction {
        /// Recipient address (required).
        #[arg(long)]
        to: TronAddress,
        /// Expected `from` address (UI rejects on mismatch).
        #[arg(long)]
        from: Option<TronAddress>,
        /// Amount in SUN (1 TRX = 1,000,000 SUN).
        #[arg(long)]
        amount: Sun,
        /// Optional hex memo (0x-hex).
        #[arg(long)]
        data: Option<HexData>,
        /// Network.
        #[arg(long)]
        network: Option<TronNetwork>,
    },
    /// Call a smart-contract function (TRC-20 transfers, etc.).
    TriggerContract {
        /// Contract address.
        #[arg(long)]
        contract: TronAddress,
        /// Expected `from` address.
        #[arg(long)]
        from: Option<TronAddress>,
        /// Function signature, e.g. `transfer(address,uint256)`.
        #[arg(long)]
        selector: String,
        /// ABI parameters as a JSON array (`[{"type":"uint256","value":"1"}]`).
        #[arg(long)]
        params: Option<JsonString>,
        /// Max energy fee in SUN.
        #[arg(long = "fee-limit")]
        fee_limit: Option<Sun>,
        /// TRX (in SUN) to send with the call.
        #[arg(long = "call-value")]
        call_value: Option<Sun>,
        /// Network.
        #[arg(long)]
        network: Option<TronNetwork>,
    },
    /// Deploy a smart contract.
    DeployContract {
        /// Path to the contract ABI JSON file.
        #[arg(long = "abi-file")]
        abi_file: PathBuf,
        /// Compiled bytecode (0x-hex).
        #[arg(long)]
        bytecode: HexData,
        /// Human-readable contract name (shown in the UI).
        #[arg(long)]
        name: Option<String>,
        /// Constructor parameters as a JSON array.
        #[arg(long)]
        params: Option<JsonString>,
        /// Expected owner address.
        #[arg(long)]
        from: Option<TronAddress>,
        /// Max energy fee in SUN.
        #[arg(long = "fee-limit")]
        fee_limit: Option<Sun>,
        /// TRX (in SUN) to send to the constructor.
        #[arg(long = "call-value")]
        call_value: Option<Sun>,
        /// Origin energy limit.
        #[arg(long = "origin-energy-limit")]
        origin_energy_limit: Option<EnergyLimit>,
        /// Percentage of fee the user pays (0-100).
        #[arg(long = "user-fee-percentage")]
        user_fee_percentage: Option<Percentage>,
        /// Network.
        #[arg(long)]
        network: Option<TronNetwork>,
    },
    /// `signMessageV2` an arbitrary message.
    SignMessage {
        /// The message to sign.
        #[arg(long)]
        message: String,
        /// Address to sign with.
        #[arg(long)]
        address: Option<TronAddress>,
        /// Network.
        #[arg(long)]
        network: Option<TronNetwork>,
    },
    /// Sign TIP-712 typed data from a JSON file (`{domain, types, primaryType, message}`).
    SignTypedData {
        /// Path to the typed-data JSON file.
        #[arg(long)]
        file: PathBuf,
        /// Address to sign with.
        #[arg(long)]
        address: Option<TronAddress>,
        /// Network.
        #[arg(long)]
        network: Option<TronNetwork>,
    },
    /// Read the native TRX balance (no browser).
    GetBalance {
        /// Address to query.
        #[arg(long)]
        address: TronAddress,
        /// Network.
        #[arg(long)]
        network: Option<TronNetwork>,
    },
    /// Read a TRC-20 token balance (no browser).
    GetTokenBalance {
        /// Token contract address.
        #[arg(long)]
        token: TronAddress,
        /// Holder address to query.
        #[arg(long)]
        address: TronAddress,
        /// Network.
        #[arg(long)]
        network: Option<TronNetwork>,
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

/// Owns the TRON signer plus presentation context for one CLI invocation; each subcommand is a
/// method rather than a free function threading `(&signer, &ctx)`.
struct TronCli {
    signer: TronSigner,
    ctx: CliContext,
}

impl TronCli {
    fn new(ctx: CliContext) -> Self {
        let browser = match &ctx.open {
            crate::OpenMode::Named(name) => BrowserChoice::Named(name.clone()),
            _ => BrowserChoice::Default,
        };
        let signer = TronSigner::new(
            BindPort::Preferred(config::port()),
            config::default_network(),
            browser,
        );
        Self { signer, ctx }
    }

    /// The effective network (explicit flag, else the signer default).
    fn network_or_default(&self, network: Option<TronNetwork>) -> TronNetwork {
        network.unwrap_or_else(|| self.signer.default_network())
    }

    /// Register, surface the URL, open unless `--print`, await, and parse into domain type `T`.
    async fn approve<T>(&self, request: TronRequest, what: &str) -> Result<T>
    where
        T: std::str::FromStr,
        <T as std::str::FromStr>::Err: std::fmt::Display,
    {
        let prepared = self.signer.prepare(request).await?;
        flow::await_signed(prepared, &self.ctx.open, &self.signer, what).await
    }

    async fn connect(
        &self,
        network: Option<TronNetwork>,
        address: Option<TronAddress>,
    ) -> Result<()> {
        let req = TronRequest::connect(Some(self.network_or_default(network)), address);
        let addr: TronAddress = self.approve(req, "tron address").await?;
        match self.ctx.output {
            OutputFormat::Text => println!("Connected: {addr}"),
            OutputFormat::Json => output::json(&json!({ "address": addr.to_base58() })),
        }
        Ok(())
    }

    async fn send_transaction(&self, params: SendTransactionParams) -> Result<()> {
        let network = self.network_or_default(params.network);
        let hash: TxHash = self
            .approve(TronRequest::send_transaction(params), "tx hash")
            .await?;
        self.emit_tx(network, &hash);
        Ok(())
    }

    async fn trigger_contract(&self, params: TriggerContractParams) -> Result<()> {
        let network = self.network_or_default(params.network);
        let hash: TxHash = self
            .approve(TronRequest::trigger_contract(params), "tx hash")
            .await?;
        self.emit_tx(network, &hash);
        Ok(())
    }

    async fn deploy_contract(
        &self,
        abi_file: &std::path::Path,
        params: DeployContractParams,
    ) -> Result<()> {
        let network = self.network_or_default(params.network);
        let abi_contents = std::fs::read_to_string(abi_file)
            .with_context(|| format!("reading ABI file {}", abi_file.display()))?;
        let params = DeployContractParams {
            abi: serde_json::from_str(&abi_contents).context("parsing ABI JSON")?,
            ..params
        };
        let prepared = self
            .signer
            .prepare(TronRequest::deploy_contract(params))
            .await?;
        let raw = flow::await_raw(prepared, &self.ctx.open, &self.signer).await?;
        let res = parse_deploy_result(&raw)?;
        let explorer = tx_explorer(network, &res.tx_hash);
        match self.ctx.output {
            OutputFormat::Text => {
                println!("Tx hash:  {}", res.tx_hash.to_hex());
                println!("Contract: {}", res.contract_address);
                if let Some(url) = &explorer {
                    println!("Explorer: {url}");
                }
            }
            OutputFormat::Json => output::json(&json!({
                "txHash": res.tx_hash.to_hex(),
                "contractAddress": res.contract_address.to_base58(),
                "explorer": explorer,
            })),
        }
        Ok(())
    }

    async fn sign_typed_data(
        &self,
        file: &std::path::Path,
        address: Option<TronAddress>,
        network: Option<TronNetwork>,
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
        let req =
            TronRequest::sign_typed_data(typed, address, Some(self.network_or_default(network)));
        self.sign(req).await
    }

    /// Shared tail for `sign_message` / `sign_typed_data`: await a signature and emit it.
    async fn sign(&self, req: TronRequest) -> Result<()> {
        let sig: Signature = self.approve(req, "signature").await?;
        match self.ctx.output {
            OutputFormat::Text => println!("Signature: {sig}"),
            OutputFormat::Json => output::json(&json!({ "signature": sig.to_string() })),
        }
        Ok(())
    }

    async fn get_balance(&self, address: &TronAddress, network: Option<TronNetwork>) -> Result<()> {
        let res = self.signer.get_balance(address, network).await?;
        match self.ctx.output {
            OutputFormat::Text => {
                println!("Balance: {} {}", res.amount.to_trx_string(), res.symbol);
                println!("Sun:     {}", res.amount);
            }
            OutputFormat::Json => output::json(&json!({
                "balance": res.amount.to_trx_string(),
                "sun": res.amount.to_string(),
                "symbol": res.symbol.to_string(),
            })),
        }
        Ok(())
    }

    async fn get_token_balance(
        &self,
        token: &TronAddress,
        address: &TronAddress,
        network: Option<TronNetwork>,
    ) -> Result<()> {
        let res = self
            .signer
            .get_token_balance(token, address, network)
            .await?;
        match self.ctx.output {
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
        Ok(())
    }

    fn emit_tx(&self, network: TronNetwork, hash: &TxHash) {
        let explorer = tx_explorer(network, hash);
        match self.ctx.output {
            OutputFormat::Text => {
                println!("Tx hash: {}", hash.to_hex());
                if let Some(url) = &explorer {
                    println!("Explorer: {url}");
                }
            }
            OutputFormat::Json => output::json(&json!({
                "txHash": hash.to_hex(),
                "explorer": explorer,
            })),
        }
    }
}

/// Build the tronscan transaction URL for a network + hash.
fn tx_explorer(network: TronNetwork, hash: &TxHash) -> Option<Url> {
    let n = config::network_config(network)?;
    Url::parse(&format!(
        "{}/#/transaction/{}",
        n.block_explorer,
        hash.to_hex()
    ))
    .ok()
}

/// Run a TRON subcommand by dispatching to the matching [`TronCli`] method.
pub(crate) async fn run(cmd: TronCommand, ctx: CliContext) -> Result<()> {
    let cli = TronCli::new(ctx);
    match cmd {
        TronCommand::Connect { network, address } => cli.connect(network, address).await,
        TronCommand::SendTransaction {
            to,
            from,
            amount,
            data,
            network,
        } => {
            cli.send_transaction(SendTransactionParams {
                to,
                from,
                amount,
                data,
                network,
            })
            .await
        }
        TronCommand::TriggerContract {
            contract,
            from,
            selector,
            params,
            fee_limit,
            call_value,
            network,
        } => {
            cli.trigger_contract(TriggerContractParams {
                contract_address: contract,
                from,
                function_selector: selector,
                parameters: params.map(JsonString::into_value),
                fee_limit,
                call_value,
                network,
            })
            .await
        }
        TronCommand::DeployContract {
            abi_file,
            bytecode,
            name,
            params,
            from,
            fee_limit,
            call_value,
            origin_energy_limit,
            user_fee_percentage,
            network,
        } => {
            let deploy = DeployContractParams {
                abi: serde_json::Value::Null, // filled from --abi-file inside deploy_contract
                bytecode,
                contract_name: name,
                parameters: params.map(JsonString::into_value),
                from,
                fee_limit,
                call_value,
                origin_energy_limit,
                user_fee_percentage,
                network,
            };
            cli.deploy_contract(&abi_file, deploy).await
        }
        TronCommand::SignMessage {
            message,
            address,
            network,
        } => {
            let req =
                TronRequest::sign_message(message, address, Some(cli.network_or_default(network)));
            cli.sign(req).await
        }
        TronCommand::SignTypedData {
            file,
            address,
            network,
        } => cli.sign_typed_data(&file, address, network).await,
        TronCommand::GetBalance { address, network } => cli.get_balance(&address, network).await,
        TronCommand::GetTokenBalance {
            token,
            address,
            network,
        } => cli.get_token_balance(&token, &address, network).await,
    }
}
