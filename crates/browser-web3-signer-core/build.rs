//! Embeds the build's version as `BWS_VERSION`, for the approval pages to show.

use std::process::Command;

fn main() {
    println!("cargo:rustc-env=BWS_VERSION={}", version());
}

/// Returns `git describe` of the checkout (`v0.5.0-2-g8fa5983-dirty`), or the package version
/// outside a git checkout (a crates.io build).
fn version() -> String {
    let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) else {
        return env!("CARGO_PKG_VERSION").to_owned();
    };
    // ponytail: dirty-ness is re-checked only when something under crates/ or the git index
    // changes; an edit elsewhere (tests/, docs/) leaves a stale clean/dirty suffix until then.
    for path in ["HEAD", "index", "refs/tags"] {
        println!("cargo:rerun-if-changed={git_dir}/{path}");
    }
    println!("cargo:rerun-if-changed=..");
    git(&["describe", "--tags", "--match", "v*", "--dirty", "--always"])
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned())
}

/// Returns git's trimmed stdout, or `None` when git is missing or fails.
fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
