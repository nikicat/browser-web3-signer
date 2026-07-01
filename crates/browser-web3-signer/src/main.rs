//! `browser-web3-signer` — the agent-facing CLI for browser wallet signing.
//!
//! Each command (one-shot) opens a local browser page where the user approves the operation in
//! their own wallet, then prints the result. The private key never leaves the browser.

mod evm;
mod flow;
mod output;
mod serve;
mod tron;

use clap::{Args, Parser, Subcommand, ValueEnum};

/// Shared CLI context derived from the global options.
pub(crate) struct CliContext {
    /// Output format.
    pub(crate) output: OutputFormat,
    /// How to open the approval URL.
    pub(crate) open: OpenMode,
}

/// A CLI argument that must be valid JSON. Parsed and validated when the argument is read, so a
/// malformed `--params` fails at the boundary rather than deep in a request builder.
#[derive(Debug, Clone)]
pub(crate) struct JsonString(serde_json::Value);

impl JsonString {
    /// Consume into the parsed JSON value.
    pub(crate) fn into_value(self) -> serde_json::Value {
        self.0
    }
}

impl std::str::FromStr for JsonString {
    type Err = serde_json::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        serde_json::from_str(s).map(JsonString)
    }
}

/// Browser-based web3 wallet signing from the command line.
#[derive(Debug, Parser)]
#[command(name = "browser-web3-signer", version, about, long_about = None)]
struct Cli {
    #[command(flatten)]
    global: GlobalOpts,
    #[command(subcommand)]
    command: Command,
}

/// Options available on every subcommand.
#[derive(Debug, Args)]
struct GlobalOpts {
    /// Print the approval URL but do not open a browser (open it yourself).
    ///
    /// To open a specific browser instead of the OS default, set the `BROWSER` environment
    /// variable (e.g. `BROWSER=firefox`).
    #[arg(long, global = true)]
    print: bool,

    /// Emit machine-readable JSON on stdout instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,
}

/// How the CLI should present results, derived from [`GlobalOpts`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputFormat {
    /// Human-readable lines.
    Text,
    /// A single JSON object.
    Json,
}

/// Whether and how to open the approval URL.
#[derive(Debug, Clone)]
pub(crate) enum OpenMode {
    /// Open in the OS default browser (honoring `$BROWSER`).
    Default,
    /// Do not open; the user opens the printed URL themselves.
    PrintOnly,
}

impl GlobalOpts {
    const fn output(&self) -> OutputFormat {
        if self.json {
            OutputFormat::Json
        } else {
            OutputFormat::Text
        }
    }

    const fn open_mode(&self) -> OpenMode {
        if self.print {
            OpenMode::PrintOnly
        } else {
            OpenMode::Default
        }
    }
}

impl OpenMode {
    /// The engine-level [`BrowserChoice`] this open mode corresponds to. Used by `serve`, which
    /// hands the choice to the engine (rather than driving the open itself like the one-shot CLI).
    pub(crate) const fn browser_choice(&self) -> browser_web3_signer_core::BrowserChoice {
        use browser_web3_signer_core::BrowserChoice;
        match self {
            Self::Default => BrowserChoice::Default,
            Self::PrintOnly => BrowserChoice::Print,
        }
    }
}

#[derive(Debug, Subcommand)]
enum Command {
    /// EVM chains (Ethereum, Polygon, Arbitrum, …).
    Evm {
        #[command(subcommand)]
        cmd: evm::EvmCommand,
    },
    /// TRON (mainnet, Shasta, Nile) via TronLink.
    Tron {
        #[command(subcommand)]
        cmd: tron::TronCommand,
    },
    /// Run the long-lived control API for a single chain (for language bindings).
    ///
    /// Holds the bridge on a stable port for the process lifetime and exposes
    /// `POST /api/v1/request` + `GET /api/v1/health`. Prints the bound port to stdout, then
    /// blocks. A binding spawns this, reads the port, and drives the wallet over HTTP; the
    /// persistent tab lets the wallet skip the reconnect prompt across calls.
    Serve {
        /// Which chain's requests to serve.
        #[arg(long, value_enum)]
        chain: Chain,
    },
}

/// Which chain a `serve` process drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Chain {
    /// EVM chains via an injected/EIP-6963 wallet.
    Evm,
    /// TRON via TronLink.
    Tron,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let ctx = CliContext {
        output: cli.global.output(),
        open: cli.global.open_mode(),
    };

    match cli.command {
        Command::Evm { cmd } => evm::run(cmd, ctx).await,
        Command::Tron { cmd } => tron::run(cmd, ctx).await,
        Command::Serve { chain } => run_serve(chain, &ctx).await,
    }
}

/// Dispatch `serve` for the chosen chain: pick the chain's embedded UI, `from_json`, and preferred
/// port, then run the control API until the process is killed.
async fn run_serve(chain: Chain, ctx: &CliContext) -> anyhow::Result<()> {
    use browser_web3_signer_core::BindPort;
    let browser = ctx.open.browser_choice();
    match chain {
        Chain::Evm => {
            serve::run::<browser_web3_signer_evm::EvmRequest>(
                browser_web3_signer_evm::WEB_UI,
                BindPort::Preferred(browser_web3_signer_evm::port()),
                browser,
            )
            .await
        }
        Chain::Tron => {
            serve::run::<browser_web3_signer_tron::TronRequest>(
                browser_web3_signer_tron::WEB_UI,
                BindPort::Preferred(browser_web3_signer_tron::port()),
                browser,
            )
            .await
        }
    }
}
