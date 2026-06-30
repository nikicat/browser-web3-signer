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

This requires the `browser-web3-signer` binary to be built (`cargo build`); the client resolves
it from the workspace `target/{release,debug}` or `PATH`, or you can pass an explicit `binPath`.

## Usage

```ts
import { WalletSignerClient, connectWalletViem } from "browser-web3-signer-ts";
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
a real wallet.
