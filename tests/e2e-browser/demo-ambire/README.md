# Ambire real-wallet demo tooling

Scripted, repeatable full-e2e flow with a **real wallet** (Ambire) for demo
recording and manual-grade verification: the real `browser-web3-signer` CLI, the
real bridge + approval page, the production Ambire release build, and a local
anvil chain — with **no manual wallet setup**. Ambire's own e2e mechanism is
used to skip onboarding: a baked `chrome.storage.local` fixture is injected into
a fresh profile ([their bootstrap](https://github.com/AmbireTech/extension/blob/main/e2e-playwright-tests/common-helpers/bootstrap.ts)).

Everything runs inside Xvfb — nothing appears on your desktop.

```sh
./setup.sh                                              # once: download the pinned Ambire release
xvfb-run -a -s "-screen 0 1600x1000x24" node drive.mts  # sign-message + send-transaction, verified
```

`record.mts` records the demo video (`demo-e2e.mp4`): a tmux-driven terminal
(neutral prompt) types the real command on the left while the Ambire-equipped
browser handles the approval on the right, captured by ffmpeg from the Xvfb
display. A warm-up authorization runs off-camera so the scene shows one popup.

`drive.mts` spawns anvil, boots Ambire from `ambire-storage.json.gz`, runs the
CLI with `--print`, opens the approval URL in the Ambire-equipped Chromium,
approves the connect/sign popups via Ambire's own `data-testid`s, and verifies
the results: the signature from CLI output, the transaction via
`eth_getTransactionReceipt` on anvil. Screenshots of every popup round are
written next to the script. Exit code 0 = both flows verified on-chain.

The wallet account is anvil's public account 0, imported as an EOA ("Basic
account"). The fixture's `networks` entry for chain 31337 was added through
Ambire's real settings UI during the bake, so its shape is canonical.

## Re-baking the fixture

Only needed when bumping `AMBIRE_VERSION` in `config.mts` (update `setup.sh`
too) or changing the account:

```sh
rm -rf ambire-build && ./setup.sh
xvfb-run -a -s "-screen 0 1600x1000x24" node bake.mts
```

## Hard-won operational notes (encoded in the scripts — keep them)

- **Xvfb screen size matters**: `xvfb-run`'s default 640×480 screen makes
  Chromium's `chrome.windows.create` fail ("Failed to open a new request
  window"), so Ambire's popup never opens. Use ≥1600×1000.
- **Wayland leaks**: with `WAYLAND_DISPLAY` set, Chromium connects to the real
  compositor and windows appear on the desktop despite Xvfb. `config.mts`
  scrubs it and pins `--ozone-platform=x11`.
- **Local Network Access**: the extension service worker can't reach
  `127.0.0.1:8545` without `--ip-address-space-overrides` + the
  `LocalNetworkAccessChecks`/`BlockInsecurePrivateNetworkRequests` feature
  disables (one combined `--disable-features` — repeated flags override).
- **Genesis block**: gas estimation requests "previous block" (−1), which can't
  resolve on a chain at genesis — `drive.mts` mines 5 blocks first.
- **Phishing DB**: the dapp-connect "security check" blocks forever if there's
  no local phishing DB and `cena.ambire.com` is erroring (it 500s regularly).
  The fixture therefore includes the `phishing`/`dappsV2` caches; a re-bake
  needs cena up to capture them.
- **Storage injection races**: inject in a throwaway launch, close, relaunch —
  Ambire's background races injection on first boot. `chrome.runtime.reload()`
  breaks unpacked extensions; don't use it.
- **Window reuse**: Ambire reuses one `request-window.html` for consecutive
  requests, and 'page' events are unreliable for it under Xvfb — the approver
  scans `ctx.pages()` statelessly each round.
- **Stale anvil**: `drive.mts` refuses to start if something already listens on
  8545 — a stale instance has unknown chain state and the new anvil dies
  silently on the taken port.
- The release build's onboarding is shorter than the dev build Ambire's own
  e2e selectors target (no story screens, no save-and-continue step).
- Benign noise in logs: `RelayerError: not supported chainId` (their relayer
  doesn't know custom chains; broadcast goes via RPC) and cena/phishing 500s.
