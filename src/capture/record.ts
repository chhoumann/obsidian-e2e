import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CdpClient } from "../runner/android/cdp";
import { probeMedia, runTool, type MediaInfo } from "./media";
import { evaluate, injectCss } from "./page";

const CURSOR_STYLE_ID = "obsidian-e2e-capture-cursor-style";

/**
 * - `x11`: ffmpeg x11grab of the window's screen region. Constant-rate and
 *   independent of CDP traffic; ~29 distinct fps at 30 fps / 2560x1600 in
 *   Xvfb. Linux/X11 only, and the window must be on-screen and unobscured.
 * - `screencast`: CDP `Page.startScreencast`. Portable (macOS, no X), captures
 *   only page pixels, but tops out around 20 distinct fps at 2560x1600.
 * - `auto` (default): `x11` when usable, otherwise `screencast`.
 */
export type RecordBackend = "auto" | "x11" | "screencast";

export interface RecordOptions {
  /** Output frame rate (default 10). With `x11` this is also the capture rate. */
  fps?: number;
  backend?: RecordBackend;
  /** JPEG quality of screencast frames (0-100). */
  quality?: number;
  /** Draw a pointer that follows DOM mouse events (CDP input moves no real cursor). */
  cursor?: boolean;
  /** Keep the raw capture directory (for debugging); otherwise always deleted. */
  keepFrames?: boolean;
}

export interface Recording {
  /**
   * Stop, encode, verify and clean up. The output is written to a sibling
   * partial file and only renamed into place once verified, so a failed or
   * `signal`-cancelled encode never replaces an existing file.
   */
  stop(options?: { signal?: AbortSignal }): Promise<RecordingResult>;
  /** Stop and discard this take's temp capture. Never touches `output`; never throws. */
  abort(): Promise<void>;
}

export interface RecordingResult extends MediaInfo {
  path: string;
  backend: "x11" | "screencast";
  /** Why `auto` fell back to screencast, when it did. */
  backendNote?: string;
  /** Wall-clock seconds between start and stop; the video duration must match it. */
  wallSeconds: number;
  /** Frames captured: distinct page frames (screencast) or grabbed frames (x11). */
  capturedFrames: number;
  /**
   * Screencast only: largest gap between delivered frames. Near 1/fps during
   * continuous motion means smooth capture; large gaps are a static screen
   * (fine) or starvation (review the contact sheet).
   */
  maxFrameGapSeconds?: number;
  /** x11 only: frames ffmpeg dropped/duplicated to hold the rate (0 = kept up). */
  droppedFrames?: number;
  duplicatedFrames?: number;
}

/** Largest gap between consecutive frame timestamps (and from start/stop). */
export function maxFrameGap(timestamps: number[], start: number, stop: number): number {
  const points = [start, ...timestamps, stop];
  let max = 0;
  for (let i = 1; i < points.length; i += 1) max = Math.max(max, points[i]! - points[i - 1]!);
  return Number(max.toFixed(3));
}

interface Frame {
  file: string;
  timestamp: number;
}

/**
 * Build an ffconcat list giving every captured frame its real on-screen
 * duration, so the encoded video is wall-clock accurate however irregularly
 * frames arrived (idle stretches produce no frames; bursts produce many).
 */
export function buildConcatList(
  frames: Frame[],
  startSeconds: number,
  stopSeconds: number,
  /** The final frame is held at least this long so very short takes still encode. */
  minLastSeconds = 0,
): string {
  if (frames.length === 0) throw new Error("no frames to encode");
  const lines = ["ffconcat version 1.0"];
  // Chrome's frame clock can sit slightly before our start; clamp into
  // [start, stop] so the durations always sum to the real elapsed time.
  const at = (t: number) => Math.min(stopSeconds, Math.max(startSeconds, t));
  frames.forEach((frame, index) => {
    const begin = index === 0 ? startSeconds : at(frame.timestamp);
    const end = index + 1 < frames.length ? at(frames[index + 1]!.timestamp) : stopSeconds;
    const last = index + 1 === frames.length;
    lines.push(`file '${frame.file.replaceAll("'", "'\\''")}'`);
    lines.push(`duration ${Math.max(last ? minLastSeconds : 0.001, end - begin).toFixed(4)}`);
  });
  // The concat demuxer ignores the last entry's duration unless it is repeated.
  lines.push(`file '${frames.at(-1)!.file.replaceAll("'", "'\\''")}'`);
  return `${lines.join("\n")}\n`;
}

export function encoderArgs(output: string, fps: number): string[] {
  const ext = path.extname(output).toLowerCase();
  const filters = `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  if (ext === ".webm") {
    return [
      "-vf",
      filters,
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "30",
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      "-row-mt",
      "1",
      "-pix_fmt",
      "yuv420p",
    ];
  }
  if (ext === ".mp4") {
    return [
      "-vf",
      filters,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
    ];
  }
  throw new Error(
    `Unsupported recording format ${ext || "(none)"}; use .webm or .mp4 (convert to GIF afterwards)`,
  );
}

const CURSOR_SCRIPT = `(() => {
  if (window.__obsidianE2ECursor) return true;
  const dot = document.createElement("div");
  dot.id = "obsidian-e2e-capture-cursor";
  document.documentElement.appendChild(dot);
  const move = (e) => { dot.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)"; dot.style.opacity = "1"; };
  const down = () => dot.classList.add("is-down");
  const up = () => dot.classList.remove("is-down");
  addEventListener("mousemove", move, true); addEventListener("mousedown", down, true); addEventListener("mouseup", up, true);
  window.__obsidianE2ECursor = () => { removeEventListener("mousemove", move, true); removeEventListener("mousedown", down, true);
    removeEventListener("mouseup", up, true); dot.remove(); delete window.__obsidianE2ECursor; };
  return true; })()`;

const CURSOR_CSS =
  "#obsidian-e2e-capture-cursor{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;" +
  "border-radius:50%;background:rgba(0,0,0,.35);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.5);" +
  "pointer-events:none;z-index:2147483647;opacity:0;transition:width .08s,height .08s,margin .08s}" +
  "#obsidian-e2e-capture-cursor.is-down{width:12px;height:12px;margin:-6px 0 0 -6px;background:rgba(0,0,0,.6)}";

/** What a capture backend hands to the shared encode/verify step. */
interface CapturedSource {
  inputArgs: string[];
  startSeconds: number;
  stopSeconds: number;
  stats: Pick<
    RecordingResult,
    "capturedFrames" | "maxFrameGapSeconds" | "droppedFrames" | "duplicatedFrames"
  >;
}

interface Capture {
  finish(): Promise<CapturedSource>;
  abort(): Promise<void>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cleanup must not hang on a renderer that stopped answering CDP. */
const CLEANUP_TIMEOUT_MS = 3000;
async function withinCleanupTimeout(step: Promise<unknown>): Promise<void> {
  await Promise.race([step.catch(() => {}), sleep(CLEANUP_TIMEOUT_MS)]);
}

/** Frames arrive ~50-170 ms after their swap time; wait for those in flight at stop. */
const SCREENCAST_DRAIN_MS = 250;

async function startScreencastCapture(
  client: CdpClient,
  dir: string,
  quality: number,
  fps: number,
): Promise<Capture> {
  const frames: Frame[] = [];
  const writes: Promise<void>[] = [];
  let writeError: Error | undefined;
  const unsubscribe = client.on("Page.screencastFrame", (params) => {
    const sessionId = params.sessionId as number;
    const metadata = params.metadata as { timestamp?: number };
    const file = path.join(dir, `frame-${String(frames.length).padStart(6, "0")}.jpg`);
    frames.push({ file, timestamp: metadata.timestamp ?? Date.now() / 1000 });
    writes.push(
      fs.writeFile(file, Buffer.from(String(params.data), "base64")).catch((error: Error) => {
        writeError ??= error;
      }),
    );
    client.call("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  const stopScreencast = async () => {
    await withinCleanupTimeout(client.call("Page.stopScreencast"));
    unsubscribe();
    await Promise.all(writes);
  };
  let startSeconds: number;
  try {
    await client.call("Page.enable");
    startSeconds = Date.now() / 1000;
    await client.call("Page.startScreencast", { format: "jpeg", quality, everyNthFrame: 1 });
  } catch (error) {
    await stopScreencast();
    throw error;
  }
  return {
    abort: stopScreencast,
    async finish() {
      const stopSeconds = Date.now() / 1000;
      await sleep(SCREENCAST_DRAIN_MS);
      await stopScreencast();
      if (writeError) throw writeError;
      const kept = frames.filter((f) => f.timestamp <= stopSeconds);
      if (kept.length === 0) {
        // A static screen emits nothing; still produce an honest still video.
        const shot = await client.call("Page.captureScreenshot", { format: "jpeg", quality });
        const file = path.join(dir, "frame-still.jpg");
        await fs.writeFile(file, Buffer.from(String(shot.data), "base64"));
        kept.push({ file, timestamp: startSeconds });
      }
      const list = path.join(dir, "frames.ffconcat");
      await fs.writeFile(list, buildConcatList(kept, startSeconds, stopSeconds, 1 / fps));
      return {
        inputArgs: ["-f", "concat", "-safe", "0", "-i", list],
        startSeconds,
        stopSeconds,
        stats: {
          capturedFrames: kept.length,
          maxFrameGapSeconds: maxFrameGap(
            kept.map((f) => f.timestamp),
            startSeconds,
            stopSeconds,
          ),
        },
      };
    },
  };
}

export interface X11Target {
  display: string;
  xauthority?: string;
  /** Window content region in physical screen pixels. */
  region: { x: number; y: number; width: number; height: number };
}

/**
 * Locate the window's content on the X display from inside the renderer, or
 * explain why x11grab cannot capture it faithfully.
 */
export async function detectX11Target(client: CdpClient): Promise<X11Target | { reason: string }> {
  return evaluate<X11Target | { reason: string }>(
    client,
    `(() => {
      if (typeof process === "undefined" || process.platform !== "linux") return { reason: "not a Linux renderer" };
      if (!process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return { reason: "no X11 DISPLAY" };
      const { remote } = require("electron");
      const win = remote.getCurrentWindow();
      if (win.isMinimized() || !win.isVisible()) return { reason: "window is not visible" };
      const b = win.getContentBounds();
      const display = remote.screen.getDisplayMatching(b);
      const s = display.scaleFactor;
      const sb = display.bounds;
      if (b.x < sb.x || b.y < sb.y || b.x + b.width > sb.x + sb.width || b.y + b.height > sb.y + sb.height)
        return { reason: "window extends beyond the X screen (use a larger capture launch --screen)" };
      const overlap = remote.BrowserWindow.getAllWindows().some((o) => {
        if (o.id === win.id || !o.isVisible() || o.isMinimized()) return false;
        const r = o.getBounds();
        return r.x < b.x + b.width && b.x < r.x + r.width && r.y < b.y + b.height && b.y < r.y + r.height;
      });
      if (overlap) return { reason: "another Obsidian window overlaps the main window" };
      const px = (v) => Math.round(v * s);
      const even = (v) => px(v) - (px(v) % 2);
      return { display: process.env.DISPLAY, xauthority: process.env.XAUTHORITY,
        region: { x: px(b.x), y: px(b.y), width: even(b.width), height: even(b.height) } };
    })()`,
  );
}

async function startX11Capture(target: X11Target, dir: string, fps: number): Promise<Capture> {
  const file = path.join(dir, "x11.mkv");
  const { x, y, width, height } = target.region;
  const child = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-stats_period",
      "0.1",
      "-progress",
      "pipe:1",
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      "-framerate",
      String(fps),
      "-video_size",
      `${width}x${height}`,
      "-i",
      `${target.display}+${x},${y}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      // Two encoder threads: measured on a 2 vCPU host, unlimited threads cut
      // a heavy scene's own frame rate 13 -> 8 fps; one thread could not
      // sustain 30 fps; two kept ~29 distinct fps in light scenes and ~10 fps
      // (of 13) in the heavy one.
      "-threads",
      "2",
      "-crf",
      "12",
      file,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        DISPLAY: target.display,
        ...(target.xauthority ? { XAUTHORITY: target.xauthority } : {}),
      },
    },
  );
  let stderr = "";
  const progress: Record<string, string> = {};
  let firstFrameAt: number | undefined;
  let onFirstFrame: () => void = () => {};
  const firstFrame = new Promise<void>((resolve) => {
    onFirstFrame = resolve;
  });
  // ffmpeg may already be gone at stop time; a failed "q" write must not crash us.
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) progress[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    if (firstFrameAt === undefined && Number(progress.frame) >= 1) {
      // Progress lags the first grab by up to one stats period; back-date it.
      firstFrameAt = Date.now() / 1000 - Math.min(0.1, Number(progress.frame) / fps);
      onFirstFrame();
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", (error) => {
      stderr += error.message;
      resolve(-1);
    });
  });
  const failed = exited.then((code) => {
    throw new Error(`x11grab exited ${code} before capturing: ${stderr.trim() || "no output"}`);
  });
  try {
    await Promise.race([
      firstFrame,
      failed,
      sleep(10_000).then(() => {
        throw new Error("x11grab produced no frame within 10 s");
      }),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  failed.catch(() => {});
  return {
    async abort() {
      child.kill("SIGKILL");
      await exited;
    },
    async finish() {
      const stopSeconds = Date.now() / 1000;
      child.stdin.end("q");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const code = await exited;
      clearTimeout(timer);
      if (code !== 0) {
        throw new Error(
          `x11grab failed (exit ${code}): ${stderr.trim() || "the grab process died during the take"}`,
        );
      }
      return {
        inputArgs: ["-i", file],
        startSeconds: firstFrameAt!,
        stopSeconds,
        stats: {
          capturedFrames: Number(progress.frame ?? 0),
          droppedFrames: Number(progress.drop_frames ?? 0),
          duplicatedFrames: Number(progress.dup_frames ?? 0),
        },
      };
    },
  };
}

/**
 * Start recording the Obsidian window (see {@link RecordBackend}). Capture and
 * final encoding are separate: nothing encodes to the output format while the
 * take runs, so busy pages or chatty drivers cannot make it fall behind or
 * compress time; `stop()` verifies the video length against wall-clock time.
 * Always pair with `abort()` on failure paths (see {@link withRecording}).
 */
export async function startRecording(
  client: CdpClient,
  output: string,
  options: RecordOptions = {},
): Promise<Recording> {
  const fps = options.fps ?? 10;
  encoderArgs(output, fps); // validate the extension before touching anything
  const requested = options.backend ?? "auto";
  let backend: "x11" | "screencast" = "screencast";
  let backendNote: string | undefined;
  let x11: X11Target | undefined;
  if (requested !== "screencast") {
    const detected = await detectX11Target(client).catch((error: Error) => ({
      reason: error.message,
    }));
    if (!detected || "reason" in detected) {
      const reason = detected?.reason ?? "renderer did not report a window";
      if (requested === "x11") throw new Error(`x11 backend unavailable: ${reason}`);
      backendNote = `x11 unavailable (${reason}); used screencast`;
    } else {
      backend = "x11";
      x11 = detected;
    }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-rec-"));
  const removeCursor = async () => {
    if (!options.cursor) return;
    await withinCleanupTimeout(
      evaluate(
        client,
        `window.__obsidianE2ECursor?.(); document.getElementById(${JSON.stringify(CURSOR_STYLE_ID)})?.remove(); true`,
      ),
    );
  };
  const removeDir = async () => {
    if (!options.keepFrames) await fs.rm(dir, { recursive: true, force: true });
  };

  let capture: Capture;
  try {
    if (options.cursor) {
      await injectCss(client, CURSOR_STYLE_ID, CURSOR_CSS);
      await evaluate(client, CURSOR_SCRIPT);
    }
    capture = await (async () => {
      if (x11) {
        try {
          return await startX11Capture(x11, dir, fps);
        } catch (error) {
          if (requested === "x11") throw error;
          backend = "screencast";
          backendNote = `x11 failed to start (${(error as Error).message}); used screencast`;
        }
      }
      return startScreencastCapture(client, dir, options.quality ?? 90, fps);
    })();
  } catch (error) {
    await removeCursor();
    await removeDir();
    throw error;
  }

  // x11grab records a fixed region: poll the window throughout the take so a
  // move/resize/overlap that is later undone still fails it. An unanswered
  // poll (e.g. mid-reload) is "unknown", not a violation.
  let x11Problem: string | undefined;
  let polling = false;
  const monitor =
    x11 && backend === "x11"
      ? setInterval(() => {
          if (polling || x11Problem) return;
          polling = true;
          void detectX11Target(client)
            .then((now) => {
              if (!now) return;
              if ("reason" in now) x11Problem = now.reason;
              else if (JSON.stringify(now.region) !== JSON.stringify(x11.region)) {
                x11Problem = `window moved or resized (${JSON.stringify(x11.region)} -> ${JSON.stringify(now.region)})`;
              }
            })
            .catch(() => {})
            .finally(() => {
              polling = false;
            });
        }, 500)
      : undefined;
  monitor?.unref();

  let finished = false;
  return {
    async abort() {
      if (finished) return;
      finished = true;
      clearInterval(monitor);
      await capture.abort().catch(() => {});
      await removeCursor();
      await removeDir().catch(() => {});
    },
    async stop(stopOptions = {}) {
      if (finished) throw new Error("recording already stopped");
      finished = true;
      const ext = path.extname(output);
      const partial = path.join(
        path.dirname(path.resolve(output)),
        `.${path.basename(output, ext)}.partial-${process.pid}${ext}`,
      );
      try {
        const source = await capture.finish();
        clearInterval(monitor);
        if (stopOptions.signal?.aborted) throw new Error("recording cancelled");
        if (x11Problem) {
          throw new Error(
            `The window was not capturable for the whole x11 take: ${x11Problem}; ` +
              "keep its geometry fixed and unobscured or use --backend screencast",
          );
        }
        if (x11 && backend === "x11") {
          // x11grab records a fixed screen region, so a window that moved,
          // resized, or became minimized/hidden/off-screen/overlapped during the
          // take would leave wrong pixels in the video: refuse such takes. Retry
          // briefly so a page mid-reload is not mistaken for a bad take.
          let after: X11Target | { reason: string } | undefined;
          for (let attempt = 0; attempt < 5 && !after; attempt += 1) {
            after = await detectX11Target(client).catch(() => undefined);
            if (!after) await sleep(300);
          }
          if (!after || "reason" in after) {
            throw new Error(
              `Cannot confirm the window stayed capturable for the whole x11 take: ${
                after ? after.reason : "renderer did not answer"
              }; use --backend screencast`,
            );
          }
          if (JSON.stringify(after.region) !== JSON.stringify(x11.region)) {
            throw new Error(
              `The window moved or resized during an x11 take (${JSON.stringify(x11.region)} -> ` +
                `${JSON.stringify(after.region)}); keep its geometry fixed or use --backend screencast`,
            );
          }
        }
        await removeCursor();
        await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
        await runTool(
          "ffmpeg",
          ["-v", "error", "-y", ...source.inputArgs, ...encoderArgs(output, fps), partial],
          stopOptions.signal,
        );
        const info = await probeMedia(partial);
        const wallSeconds = source.stopSeconds - source.startSeconds;
        if (
          info.durationSeconds === undefined ||
          Math.abs(info.durationSeconds - wallSeconds) > Math.max(0.5, 2 / fps)
        ) {
          throw new Error(
            `Encoded duration ${info.durationSeconds}s does not match wall-clock ${wallSeconds.toFixed(2)}s`,
          );
        }
        if (stopOptions.signal?.aborted) throw new Error("recording cancelled");
        await fs.rename(partial, output);
        return {
          ...info,
          path: path.resolve(output),
          backend,
          ...(backendNote ? { backendNote } : {}),
          wallSeconds,
          ...source.stats,
        };
      } catch (error) {
        clearInterval(monitor);
        await capture.abort().catch(() => {});
        await removeCursor();
        await fs.rm(partial, { force: true }).catch(() => {});
        throw error;
      } finally {
        await removeDir().catch(() => {});
      }
    },
  };
}

/**
 * Record while `action` runs. On success the video is encoded and verified; if
 * `action` throws, the recording is discarded (no half-written file is left)
 * and the original error is rethrown.
 */
export async function withRecording<T>(
  client: CdpClient,
  output: string,
  action: () => Promise<T>,
  options: RecordOptions = {},
): Promise<{ value: T; recording: RecordingResult }> {
  const recording = await startRecording(client, output, options);
  let value: T;
  try {
    value = await action();
  } catch (error) {
    await recording.abort();
    throw error;
  }
  return { value, recording: await recording.stop() };
}
