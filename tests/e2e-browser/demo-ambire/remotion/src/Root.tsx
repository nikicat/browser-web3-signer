import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo";
import type { Timeline } from "./timeline";

const FALLBACK: Timeline = {
  fps: 30,
  screen: { w: 2560, h: 1600 },
  termW: 1200,
  popup: { left: 1800, top: 140, width: 700, height: 980 },
  events: { cli_waiting: 10, tab_open: 12, sign_click: 16, popup_open: 18, popup_click: 21, success: 22, end: 26 },
};

export const Root: React.FC = () => (
  <Composition
    id="Demo"
    component={Demo}
    width={1280}
    height={800}
    fps={30}
    durationInFrames={30 * 26}
    defaultProps={{ timeline: FALLBACK }}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.ceil(props.timeline.events.end * props.timeline.fps),
      fps: props.timeline.fps,
    })}
  />
);
