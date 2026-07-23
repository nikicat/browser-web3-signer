/**
 * Camera pass: turns the high-res master recording into the final video with
 * scripted pan & zoom, keyframed from the scene timestamps the recorder emitted
 * into timeline.json. Deterministic — re-renders identically for every take.
 *
 * Run: node render.mts   (no display needed; usually invoked by record.mts)
 * Input: demo-master.mp4 + timeline.json → Output: demo-e2e.mp4
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dirname;
const OUT = { w: 1280, h: 800 };

interface Timeline {
  fps: number;
  screen: { w: number; h: number };
  termW: number;
  popup: { left: number; top: number; width: number; height: number };
  coords?: Record<string, { cx: number; cy: number }>; // measured screen-space camera targets
  events: Record<string, number>; // name → seconds since recording start
}
const tl: Timeline = JSON.parse(readFileSync(join(DIR, "timeline.json"), "utf8"));
const t = (name: string): number => {
  const v = tl.events[name];
  if (v === undefined) throw new Error(`timeline missing event: ${name}`);
  return v;
};

// Camera keyframes: {t, cx, cy, z} — z is relative to the master resolution,
// z=2 shows a quarter of the frame. Between keyframes: smoothstep easing.
const { w: W, h: H } = tl.screen;
const wide = { cx: W / 2, cy: H / 2, z: 1.0 };
// Keep the crop's left edge at 0 so the prompt's first column stays visible.
const terminal = { cx: Math.min(tl.termW * 0.5, W / 2.35 / 2), cy: H * 0.2, z: 2.35 };
// Prefer measured screen-space targets from the recorder; fall back to geometry.
const browserCard = {
  cx: tl.coords?.card?.cx ?? tl.termW + (W - tl.termW) / 2,
  cy: tl.coords?.card?.cy ?? H * 0.43,
  z: 2.1,
};
const popup = {
  cx: tl.coords?.popup?.cx ?? tl.popup.left + tl.popup.width / 2,
  cy: tl.coords?.popup?.cy ?? tl.popup.top + tl.popup.height / 2 + 25,
  z: 1.55, // whole popup incl. its bottom action row stays in frame
};
const termResult = { cx: tl.termW * 0.55, cy: H * 0.3, z: 1.7 };

const rawK: Array<{ t: number; cx: number; cy: number; z: number }> = [
  { t: 0, ...terminal }, // close-up while typing
  { t: t("cli_waiting") + 2.2, ...terminal }, // linger so the CLI output can be read
  { t: t("tab_open") + 0.7, ...wide }, // pull out as the tab opens
  { t: t("tab_open") + 1.7, ...browserCard }, // push into the approval card
  { t: t("sign_click") + 0.4, ...browserCard },
  { t: t("popup_open") + 0.8, ...popup }, // wallet popup close-up
  { t: t("popup_click") + 1.2, ...popup }, // dwell on the approved click
  { t: t("popup_click") + 2.1, ...wide }, // wide for the success flip
  { t: t("success") + 1.6, ...termResult }, // land on the tx hash
  { t: t("end"), ...termResult },
];
// Instant chains (anvil) can fire success right after popup_click — keep the
// keyframes strictly increasing so segments never collide.
const K = rawK.map((k) => ({ ...k }));
for (let i = 1; i < K.length; i++) K[i].t = Math.max(K[i].t, K[i - 1].t + 0.35);

// Piecewise smoothstep interpolation as an ffmpeg expression of frame index `in`.
const fps = tl.fps;
function piecewise(pick: (k: (typeof K)[number]) => number): string {
  let expr = String(pick(K[K.length - 1]));
  for (let i = K.length - 2; i >= 0; i--) {
    const a = K[i];
    const b = K[i + 1];
    const fa = (a.t * fps).toFixed(2);
    const fb = (b.t * fps).toFixed(2);
    const va = pick(a);
    const vb = pick(b);
    const seg =
      va === vb
        ? String(va)
        : `(${va}+(${vb - va})*pow(min(max((in-${fa})/(${fb}-${fa}),0),1),2)*(3-2*min(max((in-${fa})/(${fb}-${fa}),0),1)))`;
    expr = `if(lt(in,${fb}),${seg},${expr})`;
  }
  return expr;
}

const zExpr = piecewise((k) => k.z);
const cxExpr = piecewise((k) => k.cx);
const cyExpr = piecewise((k) => k.cy);
// zoompan: x/y are the crop's top-left in input pixels; clamp to the frame.
const xExpr = `max(0,min(iw-iw/zoom,(${cxExpr})-iw/(2*zoom)))`;
const yExpr = `max(0,min(ih-ih/zoom,(${cyExpr})-ih/(2*zoom)))`;

const vf = `zoompan=d=1:fps=${fps}:s=${OUT.w}x${OUT.h}:z='${zExpr}':x='${xExpr}':y='${yExpr}'`;
const res = spawnSync(
  "ffmpeg",
  ["-y", "-i", join(DIR, "demo-master.mp4"), "-vf", vf, "-codec:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", join(DIR, "demo-e2e.mp4")],
  { stdio: ["ignore", "inherit", "pipe"] },
);
if (res.status !== 0) {
  console.error(res.stderr.toString().slice(-1500));
  process.exit(1);
}
console.log(`rendered: ${join(DIR, "demo-e2e.mp4")}`);
