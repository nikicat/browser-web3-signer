//! `browser-web3-signer` — the agent-facing CLI for browser wallet signing.
//!
//! Each command (one-shot) opens a local browser page where the user approves the operation in
//! their own wallet, then prints the result. The private key never leaves the browser.

mod evm;
mod flow;
mod output;
mod tron;

use clap::{Args, Parser, Subcommand};

/// Shared CLI context derived from the global options.
pub struct CliContext {
    /// Output format.
    pub output: OutputFormat,
    /// How to open the approval URL.
    pub open: OpenMode,
}

/// A CLI argument that must be valid JSON. Parsed and validated when the argument is read, so a
/// malformed `--params` fails at the boundary rather than deep in a request builder.
#[derive(Debug, Clone)]
pub struct JsonString(serde_json::Value);

impl JsonString {
    /// Consume into the parsed JSON value.
    pub fn into_value(self) -> serde_json::Value {
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
    /// Open the approval page in a specific browser (name like `firefox`/`google-chrome`, or a path).
    #[arg(long, global = true, value_name = "NAME")]
    browser: Option<String>,

    /// Print the approval URL but do not open a browser (open it yourself).
    #[arg(long, global = true)]
    print: bool,

    /// Emit machine-readable JSON on stdout instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,
}

/// How the CLI should present results, derived from [`GlobalOpts`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    /// Human-readable lines.
    Text,
    /// A single JSON object.
    Json,
}

/// Whether and how to open the approval URL.
#[derive(Debug, Clone)]
pub enum OpenMode {
    /// Open in the OS default browser.
    Default,
    /// Open in a named browser.
    Named(String),
    /// Do not open; the user opens the printed URL themselves.
    PrintOnly,
}

impl GlobalOpts {
    fn output(&self) -> OutputFormat {
        if self.json {
            OutputFormat::Json
        } else {
            OutputFormat::Text
        }
    }

    fn open_mode(&self) -> OpenMode {
        if self.print {
            OpenMode::PrintOnly
        } else if let Some(name) = &self.browser {
            OpenMode::Named(name.clone())
        } else {
            OpenMode::Default
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
    }
}
