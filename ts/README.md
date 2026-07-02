# browser-web3-signer — TypeScript binding

A thin TypeScript client over the Rust `serve` control API, plus a **viem** transport and hybrid
account. It lets a Node program sign EVM transactions and messages with the user's own browser
wallet (MetaMask, Rabby, …) — the private key never leaves the browser.

## How it works

```
your Node program
  │  new WalletSignerClient("evm")
  ▼
ServeProcess ── spawn ──►  browser-web3-signer serve --chain evm   (Rust)
  │  ◄── reads bound port      owns the bridge + persistent browser tab
  │  POST /api/v1/request ────► opens the wallet, you approve, result returned
  ▼
viem transport / account  ── route personal_sign / eth_sendTransaction / … to the wallet
```

The client **spawns and supervises the Rust `serve` subprocess** for its lifetime (the
cross-language analog of the reference's in-process server). The subprocess holds the bridge on a
stable port, so the wallet skips the reconnect prompt across calls. Construct one
`WalletSignerClient` and reuse it.

## Install

```sh
npm install browser-web3-signer
```

The Rust binary ships as prebuilt per-platform npm packages
(`@nikicat/browser-web3-signer-<platform>`, exact-pinned `optionalDependencies` — the esbuild
pattern), so npm installs the right one automatically; integrity, mirrors, offline cache, and
`--ignore-scripts` all work because the binary is an ordinary npm tarball. Supported platforms:
linux x64/arm64 (static musl — any distro incl. Alpine), macOS x64/arm64, windows x64.

The binary is resolved in this order:

1. explicit `binPath` option
2. `BROWSER_WEB3_SIGNER_BIN` env var
3. a workspace `target/{release,debug}` build (repo checkout / development)
4. the installed `@nikicat/browser-web3-signer-<platform>` package
5. `browser-web3-signer` on `PATH`

When the binary comes from a workspace build or `PATH` (steps 3/5), the client checks
`--version` and logs a warning on mismatch with the package version — it never refuses to run.
If nothing resolves, the error explains the fixes (reinstall for the
[npm lockfile bug](https://github.com/npm/cli/issues/4828), set `BROWSER_WEB3_SIGNER_BIN`, or
`cargo build --release`).

## Usage

```ts
import { WalletSignerClient, connectWalletViem } from "browser-web3-signer";
import { createWalletClient } from "viem";

const signer = new WalletSignerClient("evm", { defaultChainId: 1 });

// Direct API:
const address = await signer.connectWallet();
const hash = await signer.sendTransaction({ to: "0x…", value: "1000000000000000000" });
const sig = await signer.signMessage({ message: "hello" });

// viem:
const { account, transport } = await connectWalletViem(signer);
const sig2 = await account.signMessage({ message: "via viem" });               // direct sign
const wallet = createWalletClient({ account: account.address, transport });     // routed send
const hash2 = await wallet.sendTransaction({
  account: account.address, chain: null,
  to: "0x…", value: 1_000000000000000000n,
});

await signer.shutdown(); // kill the subprocess when done
```

`connect`/`send`/`sign` block until you approve (or reject) in the browser wallet. A rejection
surfaces as a thrown `Error`; a connected-address mismatch as `WrongWalletAddressError`.

## Development

```sh
npm install
npm run typecheck
npm test          # integration tests against the real Rust subprocess (build the binary first)
```

The tests drive the real `serve` process but substitute a fake-wallet script for the browser (via
`--browser`), so they exercise the whole stack — spawn, port discovery, request, result — without
a real wallet. CI runs the typecheck + this suite as a dedicated `ts-binding` job on every push
and PR.
