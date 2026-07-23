/**
 * Records the demo video in two passes: a high-resolution master captured from
 * the Xvfb display (terminal typed via tmux + Chromium with real Ambire, under
 * a mutter window manager for proper frames), then render.mts applies scripted
 * pan & zoom keyframed from the scene timestamps emitted into timeline.json.
 *
 * The scene is send-transaction only; a warm-up sign-message runs off-camera so
 * the dapp is already authorized and the scene shows exactly one wallet popup.
 * The CLI runs with BROWSER pointing at a wrapper that hands the approval URL
 * to the driver, so the on-camera command has no --print flag and the tab
 * appears to open naturally.
 *
 * Run: ./setup.sh (once) && xvfb-run -a -s "-screen 0 2560x1600x24" node record.mts
 * Output: demo-master.mp4 (raw) → demo-e2e.mp4 (final, 1280x800)
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ANVIL_CHAIN_ID, CLI } from "./config.mts";
import {
  approveRequestWindow,
  bootAmbire,
  children,
  findRequestWindow,
  glideTo,
  registerCleanup,
  runCli,
  screenCenterOf,
  sleep,
  startAnvil,
} from "./lib.mts";

if (!CLI) throw new Error("browser-web3-signer binary not found — cargo build first");
const SCREEN = { w: 2560, h: 1600 };
const TERM_W = 1000; // xterm pane; browser gets the rest
const POPUP = { left: SCREEN.w - 760, top: 140, width: 700, height: 980 };
const FPS = 30;
registerCleanup(() => spawnSync("tmux", ["kill-session", "-t", "ambdemo"]));

const rpc = await startAnvil(join(import.meta.dirname, "anvil.log"));

// Window manager inside the Xvfb: real frames/stacking. openbox needs no
// D-Bus. Optional — the take degrades to frameless windows without it.
const rcPath = join(tmpdir(), "ambire-openbox-rc.xml");
writeFileSync(rcPath, `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <applications>
    <application title="*Ambire*">
      <position force="yes"><x>${POPUP.left}</x><y>${POPUP.top}</y></position>
      <size><width>${POPUP.width}</width><height>${POPUP.height}</height></size>
    </application>
  </applications>
</openbox_config>
`);
const wm = spawn("openbox", ["--config-file", rcPath], { stdio: "ignore" });
wm.on("error", () => {});
children.push(wm);
await sleep(1500);
if (wm.exitCode !== null) console.log("WARN: openbox not running — recording without a WM (pacman -S openbox)");

// ---- terminal pane first: measure it so the browser starts where it ends ----
const work = mkdtempSync(join(tmpdir(), "ambire-rec-"));
const urlFile = join(work, "approval-url.txt");
const wrapper = join(work, "browser-open.sh");
writeFileSync(wrapper, `#!/bin/sh\necho "$1" >> ${urlFile}\n`);
chmodSync(wrapper, 0o755);

// Neutral shell: no hostname/user in the prompt.
spawnSync("tmux", ["new-session", "-d", "-s", "ambdemo", "-x", "70", "-y", "52",
  "-e", `BROWSER=${wrapper}`, "-e", `PATH=${dirname(CLI)}:${process.env.PATH}`, "-e", "PS1=$ ",
  "bash --norc --noprofile"]);
spawnSync("tmux", ["set", "-t", "ambdemo", "status", "off"]);
const xterm = spawn("xterm", [
  "-fa", "DejaVu Sans Mono", "-fs", "20",
  "-bg", "#0d1117", "-fg", "#e6edf3",
  "-T", "terminal", "-geometry", "70x52+0+0",
  "-e", "tmux", "attach", "-t", "ambdemo",
]);
children.push(xterm);
await sleep(2500);
spawnSync("tmux", ["send-keys", "-t", "ambdemo", "clear", "Enter"]);

// Measured outer width of the xterm window (incl. WM frame) — no guessing.
let termW = TERM_W;
const geo = spawnSync("bash", ["-c", "xdotool search --name '^terminal$' getwindowgeometry --shell | grep WIDTH="]).stdout.toString();
const gw = geo.match(/WIDTH=(\d+)/);
if (gw) termW = parseInt(gw[1], 10) + 12;
console.log("terminal pane width:", termW);

const { ctx, extId, tab } = await bootAmbire({
  cursorOverlay: true,
  extraArgs: [
    `--window-position=${termW},0`,
    `--window-size=${SCREEN.w - termW},${SCREEN.h - 44}`,
  ],
});

// ---- warm-up (off-camera): authorize the dapp so the scene has one popup ----
{
  const warm = runCli(CLI, ["evm", "sign-message", "--message", "warmup"]);
  const page = await ctx.newPage();
  await page.goto(await warm.url, { waitUntil: "load" });
  await page.getByRole("button", { name: /sign/i }).first().click();
  if (!(await approveRequestWindow(ctx, ["dapp-connect-button"], { rounds: 8 }))) throw new Error("warmup connect failed");
  if (!(await approveRequestWindow(ctx, ["button-sign"], { rounds: 8 }))) throw new Error("warmup sign failed");
  await warm.exit;
  await page.close();
  console.log("warm-up done (dapp authorized)");
}

// Tidy the browser: exactly one tab (the wallet dashboard) before the scene
await tab.goto(`chrome-extension://${extId}/tab.html#/dashboard`, { waitUntil: "load" }).catch(() => {});
for (const p of ctx.pages()) if (p !== tab && !p.isClosed()) await p.close().catch(() => {});
await sleep(1000);

await sleep(800);

// ---- start recording the master ----
const events: Record<string, number> = {};
const ffmpegLog = createWriteStream(join(import.meta.dirname, "ffmpeg.log"));
const ffmpeg = spawn("ffmpeg", [
  "-y", "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(FPS),
  "-video_size", `${SCREEN.w}x${SCREEN.h}`, "-i", process.env.DISPLAY!,
  "-codec:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  join(import.meta.dirname, "demo-master.mp4"),
]);
ffmpeg.stderr.pipe(ffmpegLog);
await sleep(1500);
const recStart = Date.now();
const mark = (name: string) => (events[name] = (Date.now() - recStart) / 1000);

// ---- the scene ----
mark("typing_start");
const command =
  `browser-web3-signer evm send-transaction --chain ${ANVIL_CHAIN_ID} --to 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --value 100000000000000000`;
for (const ch of command) {
  spawnSync("tmux", ["send-keys", "-t", "ambdemo", "-l", ch]);
  await sleep(45 + Math.floor(Math.random() * 40));
}
await sleep(700);
spawnSync("tmux", ["send-keys", "-t", "ambdemo", "Enter"]);
mark("enter");

// Hold the close-up until the CLI's progress lines are on screen.
for (let i = 0; i < 40; i++) {
  const pane = spawnSync("tmux", ["capture-pane", "-t", "ambdemo", "-p"]).stdout.toString();
  if (/Waiting for approval/.test(pane)) break;
  await sleep(200);
}
mark("cli_waiting");

// The BROWSER wrapper receives the approval URL; open it as the "opened" tab.
let dappUrl = "";
for (let i = 0; i < 100 && !dappUrl; i++) {
  if (existsSync(urlFile)) dappUrl = readFileSync(urlFile, "utf8").trim().split("\n")[0] ?? "";
  if (!dappUrl) await sleep(200);
}
if (!dappUrl) {
  console.error("terminal pane at failure:\n" + spawnSync("tmux", ["capture-pane", "-t", "ambdemo", "-p"]).stdout.toString());
  throw new Error("BROWSER wrapper never received the approval URL");
}
const dapp = await ctx.newPage();
dapp.setDefaultTimeout(60000);
await dapp.goto(dappUrl, { waitUntil: "load" });
await dapp.bringToFront();
// The card can flash back to "Loading request…" once shortly after opening —
// require the button to be stably visible before letting the camera move.
const signBtn = dapp.getByRole("button", { name: /sign/i }).first();
for (let i = 0; i < 10; i++) {
  await signBtn.waitFor({ state: "visible", timeout: 30000 });
  await sleep(1200);
  if (await signBtn.isVisible().catch(() => false)) break;
}
mark("tab_open"); // card rendered — camera can push in now
await sleep(2600); // let the viewer read the transaction details

// Measured camera target: center of the approval card (heading box), on screen.
const coords: Record<string, { cx: number; cy: number }> = {};
const heading = await dapp.getByText("Send Transaction").first().boundingBox().catch(() => null);
const btnBox = await signBtn.boundingBox();
if (heading && btnBox) {
  const cardMid = {
    x: heading.x,
    y: heading.y,
    width: heading.width,
    height: btnBox.y + btnBox.height - heading.y,
  };
  coords.card = await screenCenterOf(dapp, cardMid);
}
if (btnBox) await glideTo(dapp, btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2, 1100);
await sleep(500);
await signBtn.click();
mark("sign_click");
await sleep(1000); // dwell: let the click land visually before anything moves

// Wallet popup: wait, resize to a natural wallet-window shape, dwell, approve.
let popup = null;
for (let i = 0; i < 24 && !popup; i++) {
  popup = findRequestWindow(ctx) ?? null;
  if (!popup) await sleep(1000);
}
if (!popup) throw new Error("tx popup never appeared");
await popup.waitForLoadState("load").catch(() => {});
try {
  const cdp = await ctx.newCDPSession(popup);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: POPUP });
} catch (e) {
  console.log("WARN: popup resize failed:", (e as Error).message);
}
const signId = popup.getByTestId("transaction-button-sign").first();
await signId.waitFor({ state: "visible", timeout: 15000 });
coords.popup = await popup
  .evaluate(() => ({ cx: window.screenX + window.outerWidth / 2, cy: window.screenY + window.outerHeight / 2 }))
  .catch(() => ({ cx: POPUP.left + POPUP.width / 2, cy: POPUP.top + POPUP.height / 2 }));
mark("popup_open"); // content rendered — camera can push in now
await sleep(2600); // viewer reads the wallet request
const sbox = await signId.boundingBox().catch(() => null);
if (sbox) await glideTo(popup, sbox.x + sbox.width / 2, sbox.y + sbox.height / 2, 1000);
await sleep(500);
await signId.click();
mark("popup_click");
await sleep(1200); // dwell on the click before the window closes on camera

// Success: page flips, terminal prints the hash; hold, then stop.
await dapp.getByText("Transaction Sent!").waitFor({ timeout: 30000 });
mark("success");
await sleep(4000);
mark("end");

ffmpeg.kill("SIGINT");
await new Promise((r) => ffmpeg.on("exit", r));
writeFileSync(
  join(import.meta.dirname, "timeline.json"),
  JSON.stringify({ fps: FPS, screen: SCREEN, termW, popup: POPUP, coords, events }, null, 2),
);
console.log("master + timeline written; events:", JSON.stringify(events));

// Verify on-chain (not part of the video); -J joins wrapped pane lines.
const pane = spawnSync("tmux", ["capture-pane", "-t", "ambdemo", "-p", "-J"]).stdout.toString();
const hash = pane.match(/0x[0-9a-fA-F]{64}/)?.[0];
if (hash) {
  let receipt = null;
  for (let i = 0; i < 30 && !receipt; i++) {
    receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (!receipt) await sleep(500);
  }
  console.log(`tx ${hash} receipt status: ${receipt?.status}`);
} else {
  console.log("WARN: no tx hash found in terminal pane");
}
await ctx.close();

// ---- camera pass ----
const render = spawnSync("node", [join(import.meta.dirname, "render.mts")], { stdio: "inherit" });
process.exit(render.status ?? 1);
