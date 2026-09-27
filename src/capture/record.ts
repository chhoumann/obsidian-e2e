import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CdpClient } from "../runner/android/cdp";
import { probeMedia, runTool, type MediaInfo } from "./media";
import { evaluate, injectCss } from "./page";

const CURSOR_STYLE_ID = "obsidian-e2e-capture-cursor-style";

export interface RecordOptions {
  /** Output frame rate. 10 is plenty for UI demos; the source is variable-rate. */
  fps?: number;
  /** JPEG quality of captured frames (0-100). */
  quality?: number;
  /** Draw a pointer that follows DOM mouse events (CDP input moves no real cursor). */
  cursor?: boolean;
  /** Keep the raw frame directory (for debugging); otherwise always deleted. */
  keepFrames?: boolean;
}

export interface Recording {
  /**
   * Stop, encode, verify and clean up. The output is written to a sibling
   * partial file and only renamed into place once verified, so a failed or
   * `signal`-cancelled encode never replaces an existing file.
   */
  stop(options?: { signal?: AbortSignal }): Promise<RecordingResult>;
  /** Stop and discard this take's temp frames. Never touches `output`; never throws. */
  abort(): Promise<void>;
}

export interface RecordingResult extends MediaInfo {
  path: string;
  /** Wall-clock seconds between start and stop; the video duration should match it. */
  wallSeconds: number;
  /** Distinct frames Chromium delivered (it only emits on visual change). */
  capturedFrames: number;
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
  frames.forEach((frame, index) => {
    const begin = index === 0 ? Math.min(startSeconds, frame.timestamp) : frame.timestamp;
    const end = index + 1 < frames.length ? frames[index + 1]!.timestamp : stopSeconds;
    lines.push(`file '${frame.file.replaceAll("'", "'\\''")}'`);
    const last = index + 1 === frames.length;
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

/**
 * Start a CDP screencast recording of the Obsidian window. Frames are written
 * as they arrive and encoded only at `stop()` with their real timestamps, so a
 * busy page can never make the encoder "fall behind" or compress time.
 * Always pair with `abort()` on failure paths (see {@link withRecording}).
 */
export async function startRecording(
  client: CdpClient,
  output: string,
  options: RecordOptions = {},
): Promise<Recording> {
  const fps = options.fps ?? 10;
  encoderArgs(output, fps); // validate the extension before touching anything
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-rec-"));
  const frames: Frame[] = [];
  const writes: Promise<void>[] = [];
  let sessionError: Error | undefined;

  const unsubscribe = client.on("Page.screencastFrame", (params) => {
    const sessionId = params.sessionId as number;
    const metadata = params.metadata as { timestamp?: number };
    const file = path.join(dir, `frame-${String(frames.length).padStart(6, "0")}.jpg`);
    frames.push({ file, timestamp: metadata.timestamp ?? Date.now() / 1000 });
    writes.push(
      fs.writeFile(file, Buffer.from(String(params.data), "base64")).catch((error: Error) => {
        sessionError ??= error;
      }),
    );
    client.call("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });

  const cleanupPage = async () => {
    await client.call("Page.stopScreencast").catch(() => {});
    unsubscribe();
    if (options.cursor) {
      await evaluate(
        client,
        "window.__obsidianE2ECursor?.(); document.getElementById('" +
          CURSOR_STYLE_ID +
          "')?.remove(); true",
      ).catch(() => {});
    }
    await Promise.all(writes);
  };
  const removeDir = async () => {
    if (!options.keepFrames) await fs.rm(dir, { recursive: true, force: true });
  };

  let startSeconds: number;
  try {
    if (options.cursor) {
      await injectCss(client, CURSOR_STYLE_ID, CURSOR_CSS);
      await evaluate(client, CURSOR_SCRIPT);
    }
    await client.call("Page.enable");
    startSeconds = Date.now() / 1000;
    await client.call("Page.startScreencast", {
      format: "jpeg",
      quality: options.quality ?? 90,
      everyNthFrame: 1,
    });
  } catch (error) {
    await cleanupPage();
    await removeDir();
    throw error;
  }

  let finished = false;
  return {
    async abort() {
      if (finished) return;
      finished = true;
      await cleanupPage().catch(() => {});
      await removeDir().catch(() => {});
    },
    async stop(stopOptions = {}) {
      if (finished) throw new Error("recording already stopped");
      finished = true;
      const stopSeconds = Date.now() / 1000;
      const ext = path.extname(output);
      const partial = path.join(
        path.dirname(path.resolve(output)),
        `.${path.basename(output, ext)}.partial-${process.pid}${ext}`,
      );
      try {
        await cleanupPage();
        if (sessionError) throw sessionError;
        if (frames.length === 0) {
          // A static screen emits nothing; still produce an honest still video.
          const shot = await client.call("Page.captureScreenshot", {
            format: "jpeg",
            quality: options.quality ?? 90,
          });
          const file = path.join(dir, "frame-still.jpg");
          await fs.writeFile(file, Buffer.from(String(shot.data), "base64"));
          frames.push({ file, timestamp: startSeconds });
        }
        const list = path.join(dir, "frames.ffconcat");
        await fs.writeFile(list, buildConcatList(frames, startSeconds, stopSeconds, 1 / fps));
        await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
        await runTool(
          "ffmpeg",
          [
            "-v",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list,
            ...encoderArgs(output, fps),
            partial,
          ],
          stopOptions.signal,
        );
        const info = await probeMedia(partial);
        const wallSeconds = stopSeconds - startSeconds;
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
        return { ...info, path: path.resolve(output), wallSeconds, capturedFrames: frames.length };
      } catch (error) {
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
