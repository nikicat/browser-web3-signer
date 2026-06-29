//! Browser launching and approval-URL construction (ported from `browser.ts` +
//! `tools/trigger.ts:buildOpenBrowser`).

/// Which path the in-page router should render for a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlKind {
    /// `/connect/:id` — wallet connection.
    Connect,
    /// `/sign/:id` — transaction / message / typed-data approval.
    Sign,
}

/// How (and whether) to open the approval URL in a browser.
#[derive(Debug, Clone, Default)]
pub enum BrowserChoice {
    /// Open in the OS default browser, honoring the `BROWSER` env var.
    #[default]
    Default,
    /// Open in a specific browser by name (`firefox`, `google-chrome`, …) or absolute path.
    Named(String),
    /// Do not open anything — the caller surfaces the URL for the user to open manually.
    Print,
}

/// Build the approval URL for a request id on the local bridge.
pub fn build_url(port: crate::config::Port, id: uuid::Uuid, kind: UrlKind) -> url::Url {
    let seg = match kind {
        UrlKind::Connect => "connect",
        UrlKind::Sign => "sign",
    };
    url::Url::parse(&format!("http://127.0.0.1:{port}/{seg}/{id}"))
        .expect("bridge URL is always well-formed")
}

/// Open `url` according to `choice`. Failures are logged, not returned — the user can always
/// open the URL manually (the caller is expected to have surfaced it).
pub fn open(url: &url::Url, choice: &BrowserChoice) {
    let result = match choice {
        BrowserChoice::Print => return,
        BrowserChoice::Named(name) => open_named(name, url.as_str()),
        BrowserChoice::Default => match std::env::var("BROWSER") {
            Ok(name) if !name.is_empty() => open_named(&name, url.as_str()),
            _ => opener::open(url.as_str()).map_err(|e| e.to_string()),
        },
    };
    if let Err(err) = result {
        tracing::warn!("failed to open browser: {err}; open this URL manually: {url}");
    }
}

/// Launch a named browser binary with the URL as its argument.
fn open_named(name: &str, url: &str) -> Result<(), String> {
    std::process::Command::new(name)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not launch '{name}': {e}"))
}
