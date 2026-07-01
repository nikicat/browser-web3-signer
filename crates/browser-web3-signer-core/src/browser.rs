//! Browser launching and approval-URL construction (ported from `browser.ts` +
//! `tools/trigger.ts:buildOpenBrowser`).

use url::Url;

use crate::config::Port;

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
    /// Open in the OS default browser, honoring the `BROWSER` env var (set `BROWSER=<program>`
    /// to open a specific browser).
    #[default]
    Default,
    /// Do not open anything — the caller surfaces the URL for the user to open manually.
    Print,
}

/// Build the approval URL for a request id on the local bridge.
pub fn build_url(port: Port, id: uuid::Uuid, kind: UrlKind) -> Url {
    let seg = match kind {
        UrlKind::Connect => "connect",
        UrlKind::Sign => "sign",
    };
    Url::parse(&format!("http://127.0.0.1:{port}/{seg}/{id}"))
        .expect("bridge URL is always well-formed")
}

/// Open `url` according to `choice`. Failures are logged, not returned — the user can always
/// open the URL manually (the caller is expected to have surfaced it).
///
/// Uses the `opener` crate for both the default and `$BROWSER` cases: `opener::open_browser`
/// honors `$BROWSER` when set (falling back to the OS default otherwise) and — crucially —
/// launches the browser with stdin/stdout detached. That detachment matters when the CLI's own
/// stdout is a pipe (e.g. `browser-web3-signer … | jq`): a GUI browser would otherwise inherit and
/// hold the pipe's write end open for its whole lifetime, so the downstream reader never sees EOF.
pub fn open(url: &Url, choice: &BrowserChoice) {
    match choice {
        BrowserChoice::Print => (),
        BrowserChoice::Default => {
            if let Err(err) = opener::open_browser(url.as_str()) {
                tracing::warn!("failed to open browser: {err}; open this URL manually: {url}");
            }
        }
    }
}
