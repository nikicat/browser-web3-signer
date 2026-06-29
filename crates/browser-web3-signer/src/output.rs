//! Output helpers: progress/prompt lines go to stderr so stdout stays clean (parseable as JSON
//! in `--json` mode); results go to stdout.

use serde_json::Value;

/// Print a progress or prompt line to stderr.
pub fn progress(msg: impl std::fmt::Display) {
    eprintln!("{msg}");
}

/// Print a JSON value to stdout.
pub fn json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_default()
    );
}
