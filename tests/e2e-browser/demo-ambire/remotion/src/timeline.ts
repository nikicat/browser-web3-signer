/** Shared timeline types + the camera keyframe plan (mirrors the scene design). */

export interface Timeline {
  fps: number;
  screen: { w: number; h: number };
  termW: number;
  popup: { left: number; top: number; width: number; height: number };
  coords?: Record<string, { cx: number; cy: number }>;
  events: Record<string, number>;
}

export interface CamKey {
  t: number;
  cx: number;
  cy: number;
  z: number;
}

export function cameraKeys(tl: Timeline): CamKey[] {
  const { w: W, h: H } = tl.screen;
  const t = (name: string): number => {
    const v = tl.events[name];
    if (v === undefined) throw new Error(`timeline missing event: ${name}`);
    return v;
  };

  const wide = { cx: W / 2, cy: H / 2, z: 1.0 };
  const terminal = { cx: Math.min(tl.termW * 0.5, W / 2.35 / 2), cy: H * 0.2, z: 2.35 };
  const browserCard = {
    cx: tl.coords?.card?.cx ?? tl.termW + (W - tl.termW) / 2,
    cy: tl.coords?.card?.cy ?? H * 0.43,
    z: 2.1,
  };
  const popup = {
    cx: tl.coords?.popup?.cx ?? tl.popup.left + tl.popup.width / 2,
    cy: tl.coords?.popup?.cy ?? tl.popup.top + tl.popup.height / 2 + 25,
    z: 1.55,
  };
  const termResult = { cx: tl.termW * 0.55, cy: H * 0.3, z: 1.7 };

  const raw: CamKey[] = [
    { t: 0, ...terminal },
    { t: t("cli_waiting") + 2.2, ...terminal },
    { t: t("tab_open") + 0.7, ...wide },
    { t: t("tab_open") + 1.7, ...browserCard },
    { t: t("sign_click") + 0.7, ...browserCard }, // linger on the visible click
    { t: t("popup_open") + 0.9, ...popup },
    { t: t("popup_click") + 1.2, ...popup },
    // The popup becomes the wallet's progress screen — hold until Confirmed.
    { t: (tl.events.confirmed ?? t("success")) + 1.9, ...popup },
    { t: (tl.events.confirmed ?? t("success")) + 3.1, ...termResult },
    { t: t("end"), ...termResult },
  ];
  // Keep strictly increasing (instant anvil confirmations collapse timestamps).
  for (let i = 1; i < raw.length; i++) raw[i].t = Math.max(raw[i].t, raw[i - 1].t + 0.35);
  return raw;
}

/** Piecewise smoothstep camera position at time `sec`. */
export function cameraAt(keys: CamKey[], sec: number): { cx: number; cy: number; z: number } {
  if (sec <= keys[0].t) return keys[0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (sec < b.t) {
      const p = Math.min(Math.max((sec - a.t) / (b.t - a.t), 0), 1);
      const e = p * p * (3 - 2 * p);
      return {
        cx: a.cx + (b.cx - a.cx) * e,
        cy: a.cy + (b.cy - a.cy) * e,
        z: a.z + (b.z - a.z) * e,
      };
    }
  }
  return keys[keys.length - 1];
}
