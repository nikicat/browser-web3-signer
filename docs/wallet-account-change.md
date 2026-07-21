# EVM wallet account-change mechanisms

How the approval UI gets a browser wallet to change its selected account when a request's
expected signer (`from` for transactions, `address` for connect/message signing) differs from
the connected one. The flow lives in
[`app-core.js`](../crates/browser-web3-signer-core/web/app-core.js) (chain-agnostic state
machine) and [`evm.html`](../crates/browser-web3-signer-evm/web/evm.html) (EVM adapter), shipped
in v0.3.0. This document records the **source-verified** wallet behaviors the design is built
on (verified 2026-07-21; Ambire at extension v6.14.4), so future wallet-compat work does not
have to re-research them. The e2e mock wallet
([`tests/e2e-browser/evm/fixtures/mock-wallet.mts`](../tests/e2e-browser/evm/fixtures/mock-wallet.mts))
models each behavior below.

## The cascade

Each wallet lands on the first mechanism it supports; every failure stays in-page (only an
explicit Reject/Cancel propagates to the caller), and the worst case degrades to the passive
pre-v0.3.0 behavior.

1. **Attempt-first (wallet-native switch flow).** The mismatched operation is submitted as-is
   (`eth_sendTransaction` with the requested `from`; `personal_sign` / `eth_signTypedData_v4`
   with the requested address). Wallets with a native switch flow open their own switch-account
   confirmation and continue the original request in one step.
2. **EIP-2255 `wallet_requestPermissions([{ eth_accounts: {} }])`.** Reached when the wallet
   rejected the mismatched attempt. Opens a real account picker on MetaMask; most other wallets
   resolve it silently from existing state (detected as: nothing changed **and** the call
   resolved faster than any human interaction — < 500 ms).
3. **MIP-2 `wallet_revokePermissions([{ eth_accounts: {} }])` + `eth_requestAccounts`.**
   Reached on a silent no-op in step 2. With the permission gone, the wallet must show its
   connect window, which is where accounts get picked. Caveat: the user can also just reconnect
   with the same account.
4. **Manual fallback.** When nothing above works (-32601 on both permission calls), the
   wrong-address panel shows manual-switch instructions (no dead button), and the
   `accountsChanged` listener auto-resumes the request after a manual switch — nearly every EVM
   extension emits it.

Safety invariants: a single-resume guard collapses one approval firing both `accountsChanged`
and a prompt's resolution into at most one signing; a late prompt approval after an explicit
Reject never signs (the rejection was already delivered); TRON opts out of attempt-first via
the `walletHandlesMismatch` adapter capability because tronWeb would blindly sign an
unbroadcastable transaction for a foreign owner.

## Per-wallet findings

| Wallet | Mismatched operation (`from` ≠ selected) | `wallet_requestPermissions` (connected) | MIP-2 revoke | Lands on |
|---|---|---|---|---|
| Ambire | **Switch Account Request window**, then continues the request | silent no-op | yes | step 1 |
| MetaMask | rejects, code **4100** | **opens account-permission dialog** | yes | step 2 |
| Rabby | rejects, code **-32602** | silent no-op | yes | step 3 |
| Brave | rejects (validates against allowed accounts) | silent no-op when connected | unverified | step 3 or 4 |
| OKX / Trust / Coinbase | unverified (closed native code; Coinbase has no `wallet_requestPermissions` at all) | unverified / absent | unverified | likely step 4 |

### Ambire (source: AmbireTech/extension + AmbireTech/ambire-common)

- `wallet_requestPermissions` never shows UI on a connected origin: the handler
  (`extension/src/common/modules/provider/ProviderController.ts`, `walletRequestPermissions`)
  has no `ACTION_REQUEST` metadata and synchronously answers from existing state (~40 ms).
- Submitting a sign/tx operation for **another account of the wallet** triggers the switch flow:
  `RequestsController.#buildUserRequestFromDAppRequest` takes the request's `from`/address as the
  target account with no permission filtering; a mismatch against the selected account parks the
  original request and opens the **Switch Account Request** window
  (`ambire-common/src/controllers/requests/requests.ts`, `#addSwitchAccountUserRequest`; UI
  `SwitchAccountScreen.tsx`). On confirm the extension switches accounts and the parked request
  proceeds in the same window; the dapp's original JSON-RPC call resolves with the result. On
  deny, everything rejects with 4001. Dapp account-scoping is not consulted.
- A `from` **not in the wallet at all** fails messily: transactions die on an internal error
  (-32603-ish) before the switch window; sign requests open the window with "Invalid account
  data" and only Deny works. Hence: only request addresses the user actually holds.
- Emits `accountsChanged` to connected dapps when the user switches accounts in the extension.

### MetaMask

- Operations validate `from` against the origin's permitted accounts and reject with
  `providerErrors.unauthorized()` = **4100** (`eth-json-rpc-middleware`,
  `validateAndNormalizeKeyholder`); malformed address → -32602.
- The only major wallet whose `wallet_requestPermissions` always opens the account-permission
  dialog — the canonical programmatic "switch account" path.

### Rabby (source: RabbyHub/Rabby)

- Operations reject with `invalidParams('from should be same as current address')` = **-32602**
  (`src/background/controller/provider/controller.ts`).
- `wallet_requestPermissions` is a silent stub; supports MIP-2 revoke (Ambire's rpcFlow is
  derived from Rabby's).

### Brave / OKX / Trust / Coinbase

- Brave (`brave-core`, `ethereum_provider_impl.cc`): permission request resolves without UI when
  accounts are already allowed; prompts only when nothing is connected.
- OKX documents EIP-2255 but promises no picker; Trust forwards to closed native code; the
  Coinbase Wallet SDK has no `wallet_requestPermissions` handling (they push `wallet_connect`
  / sub-accounts instead). All unverified beyond that — expected to land on step 3 or 4.

## Notes for future work

- EIP-7846 `wallet_connect` was not implemented by any of the wallets checked (2026-07); worth
  revisiting as adoption grows — it standardizes exactly this.
- When a wallet misbehaves here, check the wallet's actual source rather than EIP docs — the
  EIP-2255 UX is unspecified and implementations diverge widely (this document exists because
  two plausible mechanisms were "correct per spec" but wrong for Ambire).
