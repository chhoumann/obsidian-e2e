import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Run an external tool, turning ENOENT into an install hint. */
export async function runTool(
  file: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error(`${file} cancelled`);
  // Not execFile's own `signal`: that rejects immediately while ffmpeg keeps
  // running (and finalizing its output) for seconds. SIGKILL it instead and
  // settle only once it has exited, so callers can safely delete partials.
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        signal?.removeEventListener("abort", onAbort);
        if (!error) {
          resolve(stdout);
          return;
        }
        const err = error as NodeJS.ErrnoException;
        if (signal?.aborted) reject(new Error(`${file} cancelled`));
        else if (err.code === "ENOENT") {
          reject(
            new Error(
              `${file} is not installed (Debian/Ubuntu: apt-get install ${file === "ffprobe" ? "ffmpeg" : file})`,
            ),
          );
        } else reject(new Error(`${file} failed: ${(stderr || err.message).trim()}`));
      },
    );
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Write via a sibling partial file, verify it, then rename over `output`. */
async function writeVerified(
  output: string,
  write: (partial: string) => Promise<void>,
): Promise<MediaInfo> {
  const ext = path.extname(output);
  const partial = path.join(
    path.dirname(path.resolve(output)),
    `.${path.basename(output, ext)}.partial-${process.pid}${ext}`,
  );
  await fs.mkdir(path.dirname(partial), { recursive: true });
  try {
    await write(partial);
    const info = await probeMedia(partial);
    await fs.rename(partial, output);
    return info;
  } finally {
    await fs.rm(partial, { force: true });
  }
}

export interface MediaInfo {
  width: number;
  height: number;
  codec: string;
  bytes: number;
  durationSeconds?: number;
  frames?: number;
}

/** ffprobe summary of an image/video: the verification step after every write. */
export async function probeMedia(file: string): Promise<MediaInfo> {
  const stat = await fs.stat(file);
  if (stat.size === 0) throw new Error(`${file} is empty`);
  const raw = JSON.parse(
    await runTool("ffprobe", [
      "-v",
      "error",
      "-count_packets",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,codec_name,nb_read_packets:format=duration",
      "-of",
      "json",
      file,
    ]),
  ) as { streams?: Array<Record<string, unknown>>; format?: { duration?: string } };
  const stream = raw.streams?.[0];
  if (!stream) throw new Error(`${file} has no video/image stream`);
  const duration = Number(raw.format?.duration);
  const frames = Number(stream.nb_read_packets);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    codec: String(stream.codec_name),
    bytes: stat.size,
    ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
    ...(Number.isFinite(frames) && frames > 1 ? { frames } : {}),
  };
}

export interface GifOptions {
  /** Output width in px (height keeps aspect). Default 1280. */
  width?: number;
  fps?: number;
  colors?: number;
  /** gifsicle --lossy level; 0 disables lossy compression. Default 40. */
  lossy?: number;
}

/**
 * Video -> documentation GIF: two-pass palette (diff stats, bayer dither) via
 * ffmpeg, then `gifsicle -O3 --lossy` when gifsicle is installed. Returns the
 * probed result plus whether gifsicle ran.
 */
export async function videoToGif(
  input: string,
  output: string,
  options: GifOptions = {},
): Promise<MediaInfo & { path: string; optimized: boolean }> {
  const width = options.width ?? 1280;
  const fps = options.fps ?? 8;
  const colors = options.colors ?? 128;
  const lossy = options.lossy ?? 40;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-gif-"));
  try {
    const raw = path.join(dir, "raw.gif");
    await runTool("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      input,
      "-vf",
      `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];` +
        "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
      raw,
    ]);
    let optimized = true;
    const info = await writeVerified(output, async (partial) => {
      try {
        await runTool("gifsicle", [
          "-O3",
          ...(lossy > 0 ? [`--lossy=${lossy}`] : []),
          raw,
          "-o",
          partial,
        ]);
      } catch (error) {
        if (!String((error as Error).message).includes("not installed")) throw error;
        optimized = false;
        await fs.copyFile(raw, partial);
      }
    });
    return { ...info, path: path.resolve(output), optimized };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export interface ContactSheetOptions {
  /** Seconds between sampled frames. Default 1. */
  every?: number;
  columns?: number;
  /** Width of each tile in px. Default 480. */
  tileWidth?: number;
}

/** One PNG grid of frames sampled across a video: a quick review of a take. */
export async function contactSheet(
  input: string,
  output: string,
  options: ContactSheetOptions = {},
): Promise<MediaInfo & { path: string; tiles: number }> {
  const every = options.every ?? 1;
  const columns = options.columns ?? 4;
  const tileWidth = options.tileWidth ?? 480;
  const { durationSeconds } = await probeMedia(input);
  const tiles = Math.max(1, Math.ceil((durationSeconds ?? every) / every));
  const rows = Math.ceil(tiles / columns);
  const info = await writeVerified(output, async (partial) => {
    await runTool("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      input,
      "-vf",
      `fps=1/${every},scale=${tileWidth}:-1,tile=${columns}x${rows}:padding=4:color=white`,
      "-frames:v",
      "1",
      "-update",
      "1",
      partial,
    ]);
  });
  return { ...info, path: path.resolve(output), tiles };
}
