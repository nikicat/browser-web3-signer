/**
 * The cursor the demo recordings draw into the page, since neither Playwright's video nor a
 * screen capture shows one: it follows Playwright's mouse and changes look while pressed.
 */

import type { BrowserContext } from "@playwright/test";

/** The overlay element's id; its `style.left`/`top` hold the last mouse position in CSS px. */
export const FAKE_CURSOR_ID = "pw-cursor";

/** A cursor's markup, its style, and the style added while a mouse button is held. */
export interface CursorLook {
  html: string;
  css: string;
  pressedCss: string;
}

/** A translucent dot centred on the pointer that grows on press. */
export const CURSOR_DOT: CursorLook = {
  html: "",
  css:
    "width:18px;height:18px;border-radius:50%;background:rgba(30,30,30,.55);border:2px solid #fff;" +
    "box-shadow:0 1px 4px rgba(0,0,0,.4);transform:translate(-50%,-50%);transition:width .12s,height .12s",
  pressedCss: "width:26px;height:26px",
};

/** A white arrow with its tip on the pointer that shrinks on press. */
export const CURSOR_ARROW: CursorLook = {
  html:
    '<svg width="22" height="30" viewBox="0 0 22 30">' +
    '<path d="M2 2 L2 24 L8 19 L12 28 L15.5 26.5 L11.5 17.5 L19 17 Z" ' +
    'fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  css: "width:22px;height:30px;transition:transform .08s",
  pressedCss: "transform:scale(0.82)",
};

/** Draws `look` in every page of `ctx`, following the mouse. */
export function addFakeCursor(ctx: Pick<BrowserContext, "addInitScript">, look: CursorLook) {
  return ctx.addInitScript(installFakeCursor, { id: FAKE_CURSOR_ID, ...look });
}

// Runs in the browser: Playwright ships it as source, so it may use only `cfg` and browser
// globals, never this module's imports or constants.
function installFakeCursor(cfg: CursorLook & { id: string }) {
  window.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent =
      `#${cfg.id}{position:fixed;z-index:99999;pointer-events:none;left:-60px;top:-60px;${cfg.css}}` +
      `#${cfg.id}.pressed{${cfg.pressedCss}}`;
    document.head.appendChild(style);
    const cur = document.createElement("div");
    cur.id = cfg.id;
    cur.innerHTML = cfg.html;
    document.body.appendChild(cur);
    window.addEventListener("mousemove", (e) => {
      cur.style.left = e.clientX + "px";
      cur.style.top = e.clientY + "px";
    }, true);
    window.addEventListener("mousedown", () => cur.classList.add("pressed"), true);
    window.addEventListener("mouseup", () => cur.classList.remove("pressed"), true);
  });
}
