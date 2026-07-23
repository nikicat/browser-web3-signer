/**
 * Camera pass: renders the final video from the high-res master + timeline.json
 * through the Remotion composition in remotion/ — subpixel pan/zoom with
 * smoothstep easing, click ripples at recorded coordinates, and padded
 * rounded-corner chrome. Deterministic: same master + timeline → same video.
 *
 * Run: node render.mts   (no display needed; usually invoked by record.mts)
 * Input: demo-master.mp4 + timeline.json → Output: demo-e2e.mp4
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dirname;
const REMOTION = join(DIR, "remotion");

if (!existsSync(join(REMOTION, "node_modules"))) {
  console.error("remotion/node_modules missing — run: cd remotion && npm install");
  process.exit(1);
}

const timeline = JSON.parse(readFileSync(join(DIR, "timeline.json"), "utf8"));
mkdirSync(join(REMOTION, "public"), { recursive: true });
copyFileSync(join(DIR, "demo-master.mp4"), join(REMOTION, "public", "demo-master.mp4"));
writeFileSync(join(REMOTION, "props.json"), JSON.stringify({ timeline }));

// Modest concurrency: the OffthreadVideo frame extractor flakes ("Failed to
// fetch ...proxy?src=...") when too many parallel tabs hammer it on a 2560x1600
// source. One retry for residual flakes.
for (let attempt = 1; ; attempt++) {
  const res = spawnSync(
    "npx",
    ["remotion", "render", "src/index.ts", "Demo", join(DIR, "demo-e2e.mp4"), "--props=props.json", "--codec", "h264", "--crf", "20", "--concurrency", "2"],
    { cwd: REMOTION, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (res.status === 0) break;
  if (attempt >= 2) process.exit(res.status ?? 1);
  console.log("render failed — retrying once");
}
console.log(`rendered: ${join(DIR, "demo-e2e.mp4")}`);
