import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { cameraAt, cameraKeys, type Timeline } from "./timeline";

const PAD = 40;

/** Expanding ripple at a click position, in master-video coordinate space. */
const Ripple: React.FC<{ x: number; y: number; clickSec: number; sec: number }> = ({ x, y, clickSec, sec }) => {
  const age = sec - clickSec;
  if (age < 0 || age > 0.7) return null;
  const p = age / 0.7;
  const size = 30 + 110 * p;
  return (
    <div
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: "50%",
        border: "5px solid rgba(139,124,246,0.9)",
        opacity: 1 - p,
        pointerEvents: "none",
      }}
    />
  );
};

export const Demo: React.FC<{ timeline: Timeline }> = ({ timeline: tl }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const sec = frame / tl.fps;

  const screenW = width - PAD * 2;
  const screenH = height - PAD * 2;
  const cam = cameraAt(cameraKeys(tl), sec);

  // Scale so the visible slice (master width / z) fills the screen area, then
  // translate to center (cx, cy) — clamped so the crop never leaves the frame.
  const s = (screenW / tl.screen.w) * cam.z;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const tx = clamp(screenW / 2 - cam.cx * s, screenW - tl.screen.w * s, 0);
  const ty = clamp(screenH / 2 - cam.cy * s, screenH - tl.screen.h * s, 0);

  const clicks = [
    { name: "click_sign", t: tl.events.sign_click },
    { name: "click_popup", t: tl.events.popup_click },
  ].filter((c) => c.t !== undefined && tl.coords?.[c.name]);

  return (
    <AbsoluteFill style={{ background: "linear-gradient(135deg, #191331 0%, #0b0d12 60%, #101725 100%)" }}>
      <div
        style={{
          position: "absolute",
          left: PAD,
          top: PAD,
          width: screenW,
          height: screenH,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 70px rgba(0,0,0,0.55), 0 4px 18px rgba(0,0,0,0.4)",
          background: "#0b0d12",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: tl.screen.w,
            height: tl.screen.h,
            transform: `translate(${tx}px, ${ty}px) scale(${s})`,
            transformOrigin: "0 0",
          }}
        >
          <OffthreadVideo src={staticFile("demo-master.mp4")} style={{ width: tl.screen.w, height: tl.screen.h }} />
          {clicks.map((c) => (
            <Ripple key={c.name} x={tl.coords![c.name].cx} y={tl.coords![c.name].cy} clickSec={c.t} sec={sec} />
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
