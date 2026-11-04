---
status: todo
tags: [btc, tron, config]
---
# Fail on an invalid network variable instead of falling back to mainnet

## Goal
`default_network()` in `crates/browser-web3-signer-btc/src/config.rs` and
`crates/browser-web3-signer-tron/src/config.rs` parses `BROWSER_WEB3_{BTC,TRON}_NETWORK` with
`.ok()` and falls back to mainnet on an invalid value, so a typo such as `signett` sends a
request to mainnet. It is also re-read from the environment on every `from_json`. The account
variable (`account_from_env`) already fails `serve` at startup on an invalid value, so the two
variables of one process disagree on validation. Done = an invalid network value is an error at
startup, and the parsed default is passed in rather than read per request.

## Decisions
- Found by an /unsmell run on the account-gating change (finding b3-5, score 8). It was left
  unfixed there because the lines were not part of that change.
