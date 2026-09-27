import fs from "node:fs/promises";
import path from "node:path";

import { CdpClient, type CdpDependencies, type CdpTargetInfo } from "../runner/android/cdp";
import { DEFAULT_CDP_PORT } from "./launch";

const STYLE_ID = "obsidian-e2e-capture-style";
const EXPAND_STYLE_ID = "obsidian-e2e-capture-expand";
const TARGET_ATTR = "data-obsidian-e2e-capture";

/**
 * Hides Obsidian's Linux-only "Secrets are not encrypted" warning, caused by
 * `--password-store=basic` in a headless profile; it is not representative UI.
 */
export const LINUX_SECRET_WARNING_CSS =
  '.mod-warning[aria-label="Secrets are not encrypted"]{display:none!important}';

export interface ConnectOptions {
  port?: number;
  /** Wait up to this long for the app to be connectable and `layoutReady`. */
  timeoutMs?: number;
  /**
   * Target another window by title/URL substring, e.g. "Settings" (a popout in
   * Obsidian 1.13+). Default: the main workspace window.
   */
  window?: string;
  deps?: CdpDependencies;
}

function isObsidianPage(target: CdpTargetInfo): boolean {
  return (
    target.type === "page" &&
    Boolean(target.webSocketDebuggerUrl) &&
    (target.url ?? "").startsWith("app://obsidian.md/")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Evaluate in the page and return the value; throws on in-page exceptions. */
export async function evaluate<T = unknown>(client: CdpClient, expression: string): Promise<T> {
  const result = await client.evaluate(expression);
  if (result.exception) throw new Error(result.exception);
  return result.value as T;
}

/**
 * Connect to the Obsidian main window over CDP and wait until the workspace
 * layout is ready. Retries through launch warm-up and page reloads (a fresh
 * connection per attempt), so it doubles as the "wait until capturable" check
 * after anything that reloads the app.
 */
export async function connectCapture(options: ConnectOptions = {}): Promise<CdpClient> {
  const port = options.port ?? DEFAULT_CDP_PORT;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const wanted = options.window;
  const matches = (t: CdpTargetInfo) =>
    wanted === undefined
      ? isObsidianPage(t)
      : t.type === "page" &&
        Boolean(t.webSocketDebuggerUrl) &&
        ((t.title ?? "").includes(wanted) || (t.url ?? "").includes(wanted));
  // Popout windows (Settings in 1.13+, pop-out tabs) are app:// pages too, so the
  // main window is identified by content, not by /json order.
  const readyExpression =
    wanted === undefined
      ? "typeof app !== 'undefined' && app.workspace?.layoutReady === true && " +
        "!document.body.classList.contains('is-popout-window')"
      : "document.readyState === 'complete'";
  const fetchJson =
    options.deps?.fetchJson ??
    (async (url: string) => (await fetch(url)).json() as Promise<unknown>);
  let lastError = "not attempted";
  // Every step (HTTP, WebSocket handshake, evaluate) is bounded by the deadline;
  // a client that connects after its attempt timed out is closed, not leaked.
  const bounded = <T>(
    step: Promise<T>,
    onLate?: (value: T) => void,
    abort?: AbortController,
  ): Promise<T> => {
    const remaining = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort?.abort();
        void step.then((value) => onLate?.(value)).catch(() => {});
        reject(new Error(`timed out after ${options.timeoutMs ?? 30_000} ms`));
      }, remaining);
    });
    return Promise.race([step, timeout]).finally(() => clearTimeout(timer));
  };
  while (true) {
    let client: CdpClient | undefined;
    try {
      const targets = (await bounded(
        fetchJson(`http://localhost:${port}/json`),
      )) as CdpTargetInfo[];
      const candidates = targets.filter(matches);
      if (candidates.length === 0) lastError = `no matching page target on CDP port ${port}`;
      for (const candidate of candidates) {
        const handshake = new AbortController();
        client = await bounded(
          CdpClient.connect(port, {
            ...options.deps,
            fetchJson: () => Promise.resolve([candidate]),
            selectTarget: (list) => list[0],
            signal: handshake.signal,
          }),
          (late) => late.close(),
          handshake,
        );
        if (await bounded(evaluate<boolean>(client, readyExpression))) return client;
        client.close();
        client = undefined;
        lastError = wanted === undefined ? "main workspace not ready" : "window still loading";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    client?.close();
    if (Date.now() >= deadline) {
      throw new Error(`Obsidian on CDP port ${port} did not become ready: ${lastError}`);
    }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
}

/** Idempotently install (or replace) a named `<style>` element. */
export async function injectCss(client: CdpClient, id: string, css: string): Promise<void> {
  await evaluate(
    client,
    `(() => { let s = document.getElementById(${JSON.stringify(id)});
      if (!s) { s = document.createElement("style"); s.id = ${JSON.stringify(id)}; document.head.appendChild(s); }
      s.textContent = ${JSON.stringify(css)}; return true; })()`,
  );
}

export interface PrepareOptions {
  /** CSS viewport size; the window content area is resized to match exactly. */
  width?: number;
  height?: number;
  /** Expected devicePixelRatio. Must match launch (`--force-device-scale-factor`). */
  scale?: number;
  theme?: "light" | "dark";
  /** Interface + text font family forced via Obsidian's override variables (not persisted). */
  font?: string;
  hideSecretWarning?: boolean;
  /**
   * Extra CSS. `font`, `hideSecretWarning` and `css` share one per-window style
   * element that is replaced whenever any of them is passed.
   */
  css?: string;
}

export interface PreparedState {
  width: number;
  height: number;
  devicePixelRatio: number;
  theme: "light" | "dark";
  font?: { family: string; available: boolean; computed: string };
}

/**
 * Apply and VERIFY capture settings: window content size, DPR, theme, font and
 * capture CSS. Throws when the result does not match what was asked for rather
 * than capturing with silently-wrong settings.
 */
export async function prepareCapture(
  client: CdpClient,
  options: PrepareOptions = {},
): Promise<PreparedState> {
  if (options.width !== undefined || options.height !== undefined) {
    const width = options.width ?? (await evaluate<number>(client, "innerWidth"));
    const height = options.height ?? (await evaluate<number>(client, "innerHeight"));
    await evaluate(
      client,
      `(async () => { const w = require("electron").remote.getCurrentWindow();
        if (w.isFullScreen()) w.setFullScreen(false);
        if (w.isMaximized()) w.unmaximize();
        w.setContentSize(${width}, ${height});
        for (let i = 0; i < 40 && (innerWidth !== ${width} || innerHeight !== ${height}); i++)
          await new Promise((r) => setTimeout(r, 50));
        return true; })()`,
    );
  }

  if (options.theme) {
    await evaluate(
      client,
      `(async () => { (window.app ?? window.opener?.app).changeTheme(${JSON.stringify(options.theme === "dark" ? "obsidian" : "moonstone")});
        for (let i = 0; i < 40 && !document.body.classList.contains(${JSON.stringify(`theme-${options.theme}`)}); i++)
          await new Promise((r) => setTimeout(r, 50));
        return true; })()`,
    );
  }

  const css: string[] = [];
  if (options.font) {
    const family = JSON.stringify(options.font);
    css.push(
      `body{--font-interface-override:${family}!important;--font-text-override:${family}!important}`,
    );
  }
  if (options.hideSecretWarning) css.push(LINUX_SECRET_WARNING_CSS);
  if (options.css) css.push(options.css);
  // Only rewrite the capture CSS when asked to, so a size-only prepare keeps it.
  if (
    options.font !== undefined ||
    options.hideSecretWarning !== undefined ||
    options.css !== undefined
  ) {
    await injectCss(client, STYLE_ID, css.join("\n"));
  }

  const state = await evaluate<PreparedState & { fontProbe?: [boolean, string] }>(
    client,
    `(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = { width: innerWidth, height: innerHeight, devicePixelRatio,
        theme: document.body.classList.contains("theme-dark") ? "dark" : "light" };
      ${
        options.font
          ? `const c = document.createElement("canvas").getContext("2d");
      const m = (f) => { c.font = f; return c.measureText("Hamburgefontsiv 0123 WMil").width; };
      const fam = ${JSON.stringify(JSON.stringify(options.font))};
      // A missing font falls back identically against both generics; an
      // installed one differs from at least one (even if metric-compatible).
      const differs = ["monospace", "serif"].some((g) => m("16px " + fam + ", " + g) !== m("16px " + g));
      out.fontProbe = [differs,
        getComputedStyle(document.querySelector(".workspace") ?? document.body).fontFamily];`
          : ""
      }
      return out; })()`,
  );
  const result: PreparedState = {
    width: state.width,
    height: state.height,
    devicePixelRatio: state.devicePixelRatio,
    theme: state.theme,
  };
  const problems: string[] = [];
  if (state.fontProbe && options.font) {
    const [available, computed] = state.fontProbe;
    result.font = { family: options.font, available, computed };
    if (!available) {
      problems.push(`font "${options.font}" is not installed (e.g. apt-get install fonts-inter)`);
    }
  }
  if (options.width !== undefined && state.width !== options.width) {
    problems.push(`viewport width ${state.width}, expected ${options.width}`);
  }
  if (options.height !== undefined && state.height !== options.height) {
    problems.push(
      `viewport height ${state.height}, expected ${options.height} (a larger Xvfb --screen may be needed)`,
    );
  }
  if (options.scale !== undefined && state.devicePixelRatio !== options.scale) {
    problems.push(
      `devicePixelRatio ${state.devicePixelRatio}, expected ${options.scale}; relaunch with ` +
        `--force-device-scale-factor=${options.scale} (capture launch --scale ${options.scale})`,
    );
  }
  if (options.theme && state.theme !== options.theme) {
    problems.push(`theme ${state.theme}, expected ${options.theme}`);
  }
  if (problems.length > 0) {
    throw new Error(`Capture settings not applied: ${problems.join("; ")}`);
  }
  return result;
}

/**
 * In-page helpers installed as `window.__obsidianE2ECapture` for `rectJs`
 * expressions and ad-hoc `eval`s. Obsidian-generic only (no plugin knowledge).
 */
const PAGE_HELPERS = `window.__obsidianE2ECapture = {
  modal() {
    // Top-most modal; popout-modal windows (e.g. Settings in 1.13+) have a bare body > .modal.
    return [...document.querySelectorAll(".modal-container .modal")].at(-1) ??
      [...document.querySelectorAll(".modal")].at(-1) ?? null;
  },
  settingItem(name, root) {
    root = root ?? this.modal() ?? document;
    return [...root.querySelectorAll(".setting-item")].find((i) =>
      (i.querySelector(".setting-item-name")?.textContent ?? "").trim() === name) ?? null;
  },
  rect(el) { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; },
};`;

export type ScreenshotTarget =
  | { kind: "viewport" }
  | { kind: "selector"; selector: string }
  | { kind: "modal" }
  /** Page expression returning `{x, y, width, height}` in CSS px (viewport-relative). */
  | { kind: "rect"; expression: string };

export interface ScreenshotOptions {
  target?: ScreenshotTarget;
  /** CSS px of context around the target (clamped to the viewport). */
  pad?: number;
  /** Lift max-height/overflow on the target and `.modal-content` so tall content is not clipped. */
  expand?: boolean;
  /** Blur focus, drop open suggestion popovers and disable spellcheck squiggles first. */
  clean?: boolean;
}

export interface ImageInfo {
  path: string;
  width: number;
  height: number;
  bytes: number;
  /** The captured region in CSS px. */
  clip: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
}

/** Read width/height from a PNG header; throws if the bytes are not a PNG. */
export function pngSize(buffer: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24 || signature.some((byte, i) => buffer[i] !== byte)) {
    throw new Error("not a PNG image");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function targetElementExpression(target: ScreenshotTarget): string | undefined {
  if (target.kind === "selector")
    return `document.querySelector(${JSON.stringify(target.selector)})`;
  if (target.kind === "modal") return "window.__obsidianE2ECapture.modal()";
  return undefined;
}

/**
 * Screenshot the viewport, an element, the active (top-most) modal, or any
 * page-computed rect, at the real devicePixelRatio. The crop happens in
 * Chromium (`clip`), so there is no DPR arithmetic or ImageMagick step, and
 * the written file is verified against the expected pixel size.
 */
export async function captureScreenshot(
  client: CdpClient,
  output: string,
  options: ScreenshotOptions = {},
): Promise<ImageInfo> {
  const target = options.target ?? { kind: "viewport" };
  const pad = options.pad ?? 0;
  await evaluate(client, PAGE_HELPERS);
  const elementExpression = targetElementExpression(target);

  try {
    if (options.clean) {
      await evaluate(
        client,
        `(() => { document.activeElement?.blur?.();
          document.querySelectorAll(".suggestion-container").forEach((e) => e.remove());
          document.querySelectorAll("input, textarea, [contenteditable]").forEach((e) => { e.spellcheck = false; });
          return true; })()`,
      );
    }
    if (elementExpression) {
      const found = await evaluate<boolean>(
        client,
        `(() => { document.querySelectorAll("[${TARGET_ATTR}]").forEach((e) => e.removeAttribute("${TARGET_ATTR}"));
          const el = ${elementExpression}; if (!el) return false;
          el.setAttribute("${TARGET_ATTR}", "target"); return true; })()`,
      );
      if (!found) {
        throw new Error(
          target.kind === "modal"
            ? "No open modal to capture"
            : `No element matches ${JSON.stringify((target as { selector: string }).selector)}`,
        );
      }
      if (options.expand) {
        await injectCss(
          client,
          EXPAND_STYLE_ID,
          `[${TARGET_ATTR}]{max-height:none!important}` +
            `[${TARGET_ATTR}] .modal-content,[${TARGET_ATTR}].modal-content{max-height:none!important;overflow:visible!important}`,
        );
      }
    }

    const rectExpression =
      target.kind === "rect"
        ? target.expression
        : elementExpression
          ? `window.__obsidianE2ECapture.rect(document.querySelector("[${TARGET_ATTR}]"))`
          : "({ x: 0, y: 0, width: innerWidth, height: innerHeight })";
    const measured = await evaluate<{
      rect: { x: number; y: number; width: number; height: number };
      vw: number;
      vh: number;
      dpr: number;
    }>(
      client,
      `(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { rect: ${rectExpression}, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio }; })()`,
    );
    const { rect, vw, vh, dpr } = measured;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
      throw new Error(`Capture target has no visible area: ${JSON.stringify(rect)}`);
    }
    if (
      rect.y + rect.height > vh + 0.5 ||
      rect.x + rect.width > vw + 0.5 ||
      rect.x < -0.5 ||
      rect.y < -0.5
    ) {
      throw new Error(
        `Capture target (${Math.round(rect.width)}x${Math.round(rect.height)} at ` +
          `${Math.round(rect.x)},${Math.round(rect.y)}) exceeds the ${vw}x${vh} viewport; ` +
          "prepare a larger viewport (e.g. --height) and/or use --expand",
      );
    }
    const x0 = Math.max(0, Math.floor(rect.x - pad));
    const y0 = Math.max(0, Math.floor(rect.y - pad));
    const x1 = Math.min(vw, Math.ceil(rect.x + rect.width + pad));
    const y1 = Math.min(vh, Math.ceil(rect.y + rect.height + pad));
    const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };

    const shot = await client.call("Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale: 1 },
    });
    const bytes = Buffer.from(typeof shot.data === "string" ? shot.data : "", "base64");
    const size = pngSize(bytes);
    const expected = { width: Math.round(clip.width * dpr), height: Math.round(clip.height * dpr) };
    if (Math.abs(size.width - expected.width) > 1 || Math.abs(size.height - expected.height) > 1) {
      throw new Error(
        `Screenshot is ${size.width}x${size.height}, expected ${expected.width}x${expected.height} ` +
          `(clip ${clip.width}x${clip.height} CSS px at DPR ${dpr})`,
      );
    }
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, bytes);
    return {
      path: path.resolve(output),
      ...size,
      bytes: bytes.length,
      clip,
      devicePixelRatio: dpr,
    };
  } finally {
    await evaluate(
      client,
      `(() => { document.getElementById("${EXPAND_STYLE_ID}")?.remove();
        document.querySelectorAll("[${TARGET_ATTR}]").forEach((e) => e.removeAttribute("${TARGET_ATTR}"));
        return true; })()`,
    ).catch(() => {});
  }
}

export interface TypeOptions {
  /** Milliseconds between characters (default 70). */
  delayMs?: number;
  /** Focus this element first; otherwise types into the currently focused element. */
  selector?: string;
  /**
   * How long to wait for the selector to appear / an editable element to take
   * focus (UI often focuses its input a beat after opening). Default 5000.
   */
  waitMs?: number;
}

/**
 * Type into the focused editable element from INSIDE the page: one CDP call
 * schedules `insertText` per character on the page's own timers and resolves
 * when done. Per-character CDP round-trips starve screencast recording; this
 * keeps typing visibly paced and the recording real-time.
 */
export async function typeText(
  client: CdpClient,
  text: string,
  options: TypeOptions = {},
): Promise<void> {
  const delay = Math.max(0, options.delayMs ?? 70);
  const selector = options.selector === undefined ? "null" : JSON.stringify(options.selector);
  const outcome = await evaluate<string>(
    client,
    `(async () => {
      const selector = ${selector};
      const editable = (e) => !!e && (e.isContentEditable || e.matches?.("input, textarea"));
      const deadline = Date.now() + ${Math.max(0, options.waitMs ?? 5000)};
      let el = null;
      let found = false;
      while (true) {
        if (selector) {
          const target = document.querySelector(selector);
          if (target) {
            found = true;
            target.focus();
            // Only accept an editable target that really took focus; otherwise
            // insertText would land in whatever still holds the selection.
            const active = document.activeElement;
            if (editable(target) && (active === target || target.contains(active))) el = target;
          }
        } else if (editable(document.activeElement)) {
          el = document.activeElement;
        }
        if (el || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!el) return selector ? (found ? "noteditable" : "missing") : "nofocus";
      for (const ch of Array.from(${JSON.stringify(text)})) {
        if (!document.execCommand("insertText", false, ch)) return "rejected";
        await new Promise((r) => setTimeout(r, ${delay}));
      }
      return "ok"; })()`,
  );
  if (outcome === "missing") {
    throw new Error(`No element matches ${JSON.stringify(options.selector)}`);
  }
  if (outcome === "noteditable") {
    throw new Error(
      `${JSON.stringify(options.selector)} is not an editable element that can take focus`,
    );
  }
  if (outcome === "nofocus") {
    throw new Error("No editable element is focused to type into; pass a selector");
  }
  if (outcome === "rejected") throw new Error("The focused element does not accept text input");
}
