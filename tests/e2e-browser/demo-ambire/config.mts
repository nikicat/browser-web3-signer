/** Shared constants for the Ambire demo-recording tooling. */
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

// Keep every window inside the Xvfb display: on a Wayland desktop Chromium
// auto-connects to the real compositor via WAYLAND_DISPLAY, ignoring DISPLAY —
// scrub it (inherited by all children) and pin ozone to X11 below.
delete process.env.WAYLAND_DISPLAY;
if (!process.env.DISPLAY) {
  throw new Error("no DISPLAY — run under xvfb-run so windows stay off the desktop");
}

// Isolate D-Bus too: without this, Chromium reaches the desktop session bus
// (via DBUS_SESSION_BUS_ADDRESS or the $XDG_RUNTIME_DIR/bus fallback) and
// spams real desktop notifications. Point XDG_RUNTIME_DIR at a private dir.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
delete process.env.DBUS_SESSION_BUS_ADDRESS;
process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "ambire-runtime-"));

export const AMBIRE_VERSION = "v6.15.3";
export const BUILD_DIR = join(import.meta.dirname, "ambire-build");
export const FIXTURE = join(import.meta.dirname, "ambire-storage.json.gz");

/** Keystore password for the baked demo wallet (test-only, protects a public anvil key). */
export const KEYSTORE_PASS = "AmbireDemo2026!";

/** anvil default account 0 (public, funded with 10000 ETH by anvil). */
export const ANVIL_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const ANVIL_CHAIN_ID = 31337;
export const ANVIL_RPC = "http://127.0.0.1:8545";

/** Storage keys worth persisting from a bake (the rest is regenerable app data). */
export const FIXTURE_KEYS = [
  "accounts",
  "keyStoreUid",
  "keystoreKeys",
  "keystoreSecrets",
  "selectedAccount",
  "learnedAssets",
  "passedMigrations",
  "agreedToBackupWarning",
  "networks",
  // Cache keys: without a local phishing DB the dapp-connect "security check"
  // blocks forever whenever cena.ambire.com is erroring (it 500s regularly).
  // Capturing these requires cena to be up during the bake.
  "phishing",
  "dappsV2",
  "domainsCache",
  "tokenBlacklist",
  "lastDappsUpdateVersion",
  "networksWithAssetsByAccount",
  "networksWithPositionsByAccounts",
];

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
export const CLI = ["release", "debug"]
  .map((p) => join(WORKSPACE_ROOT, "target", p, "browser-web3-signer"))
  .find(existsSync);

export const CHROMIUM_ARGS = [
  `--disable-extensions-except=${BUILD_DIR}`,
  `--load-extension=${BUILD_DIR}`,
  "--no-sandbox",
  "--ozone-platform=x11",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--window-size=1440,900",
  // Let the extension service worker reach the local anvil RPC: Chromium's
  // Local Network Access checks otherwise block SW fetches to 127.0.0.1
  // (same flags Ambire's own e2e bootstrap uses; features combined into one
  // flag because repeated --disable-features overrides earlier ones).
  "--ip-address-space-overrides=127.0.0.1:0=public",
  "--disable-features=DialMediaRouteProvider,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
];
