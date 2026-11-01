# ADR 0001: Bitcoin browser-wallet support

- **Status:** accepted
- **Date:** 2026-11-01

## Context

The signer supports EVM and TRON. Both are account-based secp256k1/keccak chains, and the
existing core (`Engine`, `PendingStore`, the HTTP bridge, `app-core.js`) is chain-agnostic, so
adding a chain means a new crate plus a page adapter ([ARCHITECTURE.md](../../ARCHITECTURE.md),
"Per-chain crates, shared core").

Bitcoin differs in ways that shape the design:

- **UTXOs, no accounts or contracts.** There is no "call a contract" or EIP-712. The general
  operation is signing a PSBT (BIP-174) that someone else built; the simple one is "pay this
  address N sats" with the wallet choosing coins and fee.
- **No common wallet API.** There is no EIP-1193/6963. Wallets fall into families with
  incompatible shapes: Unisat-style objects (`window.unisat`), Sats Connect / WBIP
  `request(method, params)` (Xverse, Magic Eden), Leather's own `request` params, and Phantom.
- **Txids and signatures don't fit the shared byte types.** A txid is displayed byte-reversed,
  and a message signature is base64 of variable length (BIP-322) or 65 bytes (BIP-137), so core's
  `TxHash` / `Signature` (0x-hex) don't apply.

The first target wallet is **Unisat**, the one the maintainer uses. The second is **Leather**,
because it's the one we can test end to end, automated, with the real extension (see §6).

### Unisat provider API (verified)

Read from [`unisat-wallet/wallet`](https://github.com/unisat-wallet/wallet) at `acca8c1`
(2026-08-08): `apps/extension/src/content-script/pageProvider/{index,bitcoinAPI,pushEventHandlers}.ts`,
`packages/wallet-background/src/controllers/{wallet.ts,provider/controller.ts}`,
`packages/wallet-types/src/index.ts`. (The old `unisat-wallet/extension` repo is deprecated.)

| Call | Shape | Returns |
|---|---|---|
| `requestAccounts()` / `getAccounts()` | — | `string[]`: the current account's single address |
| `getPublicKey()` | — | hex public key |
| `getChain()` / `switchChain(enum)` | `enum` ∈ `BITCOIN_MAINNET`, `BITCOIN_TESTNET`, `BITCOIN_TESTNET4`, `BITCOIN_SIGNET` (+ two Fractal chains) | `{ enum, name, network }` |
| `sendBitcoin(to, satoshis, { feeRate?, memo? })` | **one** recipient | txid (the wallet builds, signs and broadcasts) |
| `signPsbt(psbtHex, { autoFinalized?, toSignInputs? })` | `toSignInputs: [{ index, address \| publicKey, sighashTypes? }]`; omitted ⇒ sign every input the account owns | signed PSBT hex |
| `pushPsbt(psbtHex)` | finalized PSBT | txid |
| `signMessage(text, type)` | `type` ∈ `"ecdsa"`, `"bip322-simple"` | base64 signature |
| events | `accountsChanged(string[])` (`[]` on disconnect), `networkChanged(network)` | — |

`autoFinalized` defaults to true, but the wallet only finalizes when it signs *every* input
(`wallet.ts` `formatPsbt`). **Unisat has no regtest**, and its per-chain API endpoints are
hard-coded (`packages/wallet-shared/src/constants/common.ts`), so it can't be pointed at a local
node.

### Leather provider API (verified)

Read from [`leather-io/mono`](https://github.com/leather-io/mono) at
`@leather.io/extension-v6.115.0`: `packages/rpc/src/methods/{get-addresses,bitcoin/*}.ts`,
`packages/provider/src/init-inpage-provider.ts`,
`apps/extension/src/app/store/networks/networks.selectors.ts`,
`apps/extension/src/app/pages/rpc-sign-psbt/use-rpc-sign-psbt.tsx`,
`packages/services/src/utxos/utxos.service.ts`.

`window.LeatherProvider.request(method, params)` resolves to the JSON-RPC response
(`{ result }`) and rejects with it (`{ error: { code, message } }`).

| Method | Params | Result |
|---|---|---|
| `getAddresses` | `network?` | `{ addresses }`: per account a `p2wpkh` and a `p2tr` address (each with `publicKey`), plus Stacks |
| `sendTransfer` | `recipients: [{ address, amount }]` (sats), `network` | `{ txid }`. No fee-rate parameter |
| `signPsbt` | `hex`, `signAtIndex?`, `broadcast?`, `network?` | `{ hex, txid? }`. Finalizes **only** when broadcasting |
| `signMessage` | `message`, `paymentType: p2wpkh \| p2tr`, `type?: bip322 \| legacy`, `network?` | `{ signature, address }` |

`network` is a Leather network-configuration id. The built-in ids (`mainnet`, `testnet`,
`testnet4`, `signet`) are ours; an id Leather doesn't know falls back to its active network.
Leather supports regtest, and for a custom network it reads UTXOs, transactions and broadcasts
through that network's `bitcoinUrl` with standard Esplora endpoints instead of its hosted API.

## Decision

### 1. A new crate, `browser-web3-signer-btc`, on rust-bitcoin

It follows the TRON crate's layout (`types.rs`, `domain.rs`, `signer.rs`, `config.rs`,
`web/btc.html`). Its domain types come from the `bitcoin` crate (0.32): `Address`
(network-checked), `Amount`, `Txid`, `Psbt`, `Network`. That's the same move as the EVM crate
using alloy only for its primitives. Like TRON, it has no RPC client.

The `bitcoin` crate requires `secp256k1`, which builds the vendored libsecp256k1 C library
with `cc`. That costs nothing new: the release workflow already installs `musl-gcc` for
`ring`'s C sources on the static musl targets.

### 2. Four request types

| `type` | Fields | Result |
|---|---|---|
| `connect` | `network?`, `address?` | the wallet's address |
| `send_transfer` | `to`, `amount` (sats), `from?`, `feeRate?` (sat/vB), `network?` | `txid` |
| `sign_psbt` | `psbt` (hex), `from?`, `signInputs?: [index]`, `finalize?`, `broadcast?`, `network?` | `{ psbt, txid? }` |
| `sign_message` | `message`, `address?`, `protocol?: "bip322" \| "ecdsa"` (default `bip322`), `network?` | base64 signature |

- **`send_transfer` has one recipient**, because `sendBitcoin` does. Several outputs go through
  `sign_psbt`, where the caller builds the transaction.
- **PSBTs are hex on the wire**, as Unisat (and Leather) take them. The CLI accepts base64 or
  hex input.
- **`broadcast` implies `finalize`**, since `pushPsbt` needs a finalized PSBT. If the wallet
  didn't sign every input, it won't finalize, and the page reports that as an error instead of
  pushing.
- **The signer checks the returned PSBT.** It parses the wallet's PSBT and fails unless its
  unsigned transaction has the same txid as the request's. A wallet must only add signatures;
  this check makes "the tx you approved is the tx you got back" hold by construction.
- **`feeRate` is a hint.** Unisat honours it in `sendBitcoin`; Leather's `sendTransfer` has no
  such parameter, so it's dropped.
- **Finalize without broadcast** works on Unisat, not on Leather: Leather returns the PSBT
  signed but unfinalized. The page refuses that combination on Leather rather than return
  something other than what was asked.
- **`connect` returns only the address.** Core delivers a connect result as a single address
  string for every chain. A public key (which a caller needs to build Taproot key-path PSBTs)
  can follow once a caller needs it.
- **Every request carries its network**, defaulting to `BROWSER_WEB3_BTC_NETWORK`, and every
  address in it is checked against that network when the request is built.
- Reads stay with the caller ("No read side" in ARCHITECTURE.md): UTXO lookup, fee estimation,
  and broadcasting a raw tx built elsewhere. `broadcast` on `sign_psbt` is the one exception,
  because the wallet can do it and agents often have no node.

### 3. Networks

`BtcNetwork` is `mainnet | testnet | testnet4 | signet | regtest`. Unisat supports all but
regtest (the page says so); Leather supports all five. It maps to `bitcoin::Network` for address
checks: a mainnet address on a signet request fails when the request is built.

On Leather, every request names its network, so there's nothing to switch. On Unisat, the
adapter compares `getChain().enum` with the request's network and calls
`switchChain` on a mismatch. Two Unisat behaviours shape where it does that:

- **Switching chains changes the account's address** (`bc1…` on mainnet, `tb1…` on test
  networks). So the switch has to happen *before* the address is read. The EVM page's
  post-connect `onConnected` hook would be too late, because the connect result would be the
  old network's address. The adapter switches inside `requestAccounts` and before each
  operation. `currentAddress` returns "" while the wallet is on another chain, so core falls
  through to `requestAccounts` and never compares a wrong-network address.
- **`switchChain` opens an approval prompt** unless the wallet is already on that chain
  (`provider/controller.ts`). So it's only called from actions the user started (Connect, Sign).
  The page keeps the request from `onChainReady` so those calls know the target chain.

### 4. Page: `web/btc.html` with Unisat and Leather drivers

It's a thin adapter over `app-core.js`, like `tron.html`, delegating to a per-wallet driver that
owns that wallet's API. The first installed wallet wins (Unisat, then Leather); a picker can
come when someone runs both.

- **Addresses** compare case-insensitively for bech32 (`bc1…`, `tb1…`, `bcrt1…`) and exactly for
  base58.
- **Leather's two addresses.** The driver connects to the request's address if the account has
  it (so a Taproot `from` works), else the payment (native segwit) one, and signs messages with
  the matching `paymentType`.
- **No `requestAccountChange`.** Neither wallet has an account-picker request, so the page keeps
  the passive wrong-address view, as TRON does.
- **Core changes:** `app-core.js` adds `send_transfer` and `sign_psbt` to its tx-type list.
  That's the only change. The adapter's `renderTxSuccessExtra` replaces the txid with a "not
  broadcast" note for a PSBT that was only signed.

Unisat's API is shared, at least in part, by OKX (`window.okxwallet.bitcoin`) and Bitget
(`window.bitkeep.unisat`). That's unverified, so for now the adapter only looks for
`window.unisat`.

### 5. CLI and `serve`

`browser-web3-signer btc connect | send | sign-psbt | sign-message`, with `--network` /
`BROWSER_WEB3_BTC_NETWORK` (default `mainnet`) and `BROWSER_WEB3_BTC_PORT` for the bridge port
(default 3849, next to EVM's 3847 and TRON's 3848).
`serve --chain btc` reuses the generic path.

### 6. Testing: mocks for both drivers, the real Leather extension for the whole path

- **Mock providers** (`tests/e2e-browser/btc/`) cover both drivers in the main e2e job: what
  each asks its wallet for, and the result the bridge receives.
- **Real-wallet e2e** (`tests/e2e-browser/btc-leather/`, CI job `e2e-leather`) runs the actual
  CLI against the real Leather extension on a throwaway regtest chain, headless and unattended.
  `bitcoind -regtest` plus a small Esplora API over its RPC stands in for the network, the
  signed-in wallet is seeded the way Leather's own suite seeds it, and results are checked by
  the node (`testmempoolaccept`, mempool lookups) and bip322-js. Leather publishes no built
  artifacts, so `scripts/build-leather.sh` builds the pinned release in its test mode; CI caches
  it by that pin.
- **Unisat can't be tested this way.** Nothing local can stand in for its backend: 68
  proprietary endpoints, including server-side transaction building (`create-send-btc`) and
  PSBT decoding for its approval screen (`decode2`). Unisat's own repository has unit tests
  only. Its driver is covered by the mock suite.

## Consequences

- One more chain crate. In core Rust, the `FromStr` error type and the request-JSON field
  readers, which EVM and TRON each had copied, moved into a shared `parse` module rather than be
  copied a third time. The only core JS change is the two type names.
- The returned-PSBT txid check is the main safety property, and it's only cheap because we
  parse PSBTs properly (rust-bitcoin).
- The real-wallet e2e exercises everything but the Unisat driver: Rust types and checks, the
  page core, the Leather driver. The Unisat mock models the chain-switch address change.
- The first crates.io release of `browser-web3-signer-btc` can't use trusted publishing, because
  that needs the crate to exist already. It has to be published once by hand, then bound to the
  `release` environment like the others.

## Deferred

- **More wallet families**: Sats Connect / WBIP (Xverse, Magic Eden), then Phantom (it has no
  send). Each needs its API checked against source first.
- A wallet picker for people with more than one Bitcoin wallet installed.
- TS and Go bindings for Bitcoin.
- Ordinals, Runes, BRC-20, multisig, `signPsbts` (batch).

## Alternatives considered

- **Pure-Rust crates** (`bitcoin-primitives` + `bitcoin-units` + `bech32` + `base58ck`). These
  avoid C, but they're pre-1.0 (0.103 / 0.7) and have no address or PSBT types, so we'd
  hand-write address encoding and PSBT global-map parsing (~150 lines plus tests) to save a C
  dependency we already handle for `ring`.
- **`bdk_wallet`.** A wallet library with descriptors and sync is far more than we need, since
  the browser wallet owns keys and coins.
- **Opaque PSBT bytes** (no parsing). This is simpler, but it loses the returned-PSBT check and
  the CLI's preview of what's being signed.
