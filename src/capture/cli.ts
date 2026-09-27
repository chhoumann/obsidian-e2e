import { spawn } from "node:child_process";
import os from "node:os";
import process from "node:process";

import {
  DEFAULT_CDP_PORT,
  captureLaunchCommand,
  captureShellExports,
  prepareCaptureProfile,
  resolveCaptureProfile,
  runCaptureInstance,
} from "./launch";
import { contactSheet, probeMedia, videoToGif } from "./media";
import {
  captureScreenshot,
  connectCapture,
  prepareCapture,
  typeText,
  type ScreenshotTarget,
} from "./page";
import { startRecording, type RecordBackend } from "./record";

interface Spec {
  values?: string[];
  numbers?: string[];
  booleans?: string[];
}

export interface CaptureArgs {
  flags: Record<string, string | number | boolean>;
  positionals: string[];
  /** Everything after a bare `--`. */
  command: string[];
}

/** Flags may appear anywhere before a bare `--`; everything after it is a command. */
export function parseCaptureArgs(argv: readonly string[], spec: Spec): CaptureArgs {
  const flags: CaptureArgs["flags"] = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") return { flags, positionals, command: argv.slice(i + 1) };
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (spec.booleans?.includes(name)) {
      flags[name] = true;
    } else if (spec.values?.includes(name) || spec.numbers?.includes(name)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      i += 1;
      if (spec.numbers?.includes(name)) {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(`${arg} expects a number, got ${value}`);
        flags[name] = number;
      } else {
        flags[name] = value;
      }
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { flags, positionals, command: [] };
}

/** Grace before SIGKILL when a timed-out or cancelled record command ignores its signal. */
const KILL_GRACE_MS = 3000;

const CONNECT = { numbers: ["port", "timeout"], values: ["window"] };

const SPECS: Record<string, Spec> = {
  launch: {
    values: ["vault", "root", "screen", "obsidian-app"],
    numbers: ["port", "scale"],
    booleans: ["no-xvfb", "xvfb", "print-env"],
  },
  prepare: {
    values: [...CONNECT.values, "theme", "font", "css"],
    numbers: [...CONNECT.numbers, "width", "height", "scale"],
    booleans: ["hide-secret-warning"],
  },
  screenshot: {
    values: [...CONNECT.values, "selector", "rect-js"],
    numbers: [...CONNECT.numbers, "pad"],
    booleans: ["modal", "expand", "clean"],
  },
  type: { values: [...CONNECT.values, "selector"], numbers: [...CONNECT.numbers, "delay", "wait"] },
  record: {
    values: [...CONNECT.values, "backend"],
    numbers: [...CONNECT.numbers, "fps", "quality", "max-seconds"],
    booleans: ["cursor", "keep-failed-frames"],
  },
  gif: { numbers: ["width", "fps", "colors", "lossy"] },
  sheet: { numbers: ["every", "columns", "tile-width"] },
  probe: {},
};

export const CAPTURE_HELP = `obsidian-e2e capture <command>

Composable screenshot/recording primitives for a live Obsidian window over CDP.
Every command prints a JSON result (verified sizes/durations) on stdout.
Drive the UI between them with anything: agent-browser --cdp <port>, the
obsidian CLI, or 'capture type'.

  launch --vault <dir> [--port 9333] [--scale 2] [--root <dir>] [--screen 3840x3200x24]
         [--obsidian-app <exe>] [--xvfb|--no-xvfb] [--print-env] [-- <extra obsidian args>]
      Run a dedicated capture instance in the FOREGROUND (supervise it, e.g.
      amp orb service start). Own HOME/profile, CDP port, forced DPR.
  prepare [--width 1280] [--height 800] [--scale 2] [--theme light|dark] [--font Inter]
          [--hide-secret-warning] [--css <css>]
      Wait for the app, size the window, apply theme/font/CSS, verify.
  screenshot <out.png> [--modal | --selector <css> | --rect-js <expr>] [--pad <px>]
             [--expand] [--clean]
      Crop in Chromium at the real DPR; fails if the target is off-screen.
  type <text> [--selector <css>] [--delay 70] [--wait 5000]
      In-page paced typing (keeps recordings real-time). Waits up to --wait ms
      for the selector / an editable element to have focus.
  record <out.webm|out.mp4> [--fps 10] [--cursor] [--backend auto|x11|screencast]
         [--max-seconds 300] -- <command...>
      Record while <command> runs (env OBSIDIAN_E2E_CDP_PORT is set for it).
      auto = x11grab of the window when on X11 (smoothest), else CDP screencast.
      Non-zero exit/timeout/signal => no output file, same exit status.
  gif <in> <out.gif> [--width 1280] [--fps 8] [--colors 128] [--lossy 40]
  sheet <in> <out.png> [--every 1] [--columns 4] [--tile-width 480]
  probe <file>

Connection flags: --port (default $OBSIDIAN_E2E_CDP_PORT or ${DEFAULT_CDP_PORT}), --timeout <ms>,
--window <title/url substring> (e.g. Settings, a popout window in Obsidian 1.13+).`;

export interface CaptureCliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

function num(flags: CaptureArgs["flags"], name: string): number | undefined {
  return typeof flags[name] === "number" ? (flags[name] as number) : undefined;
}
function str(flags: CaptureArgs["flags"], name: string): string | undefined {
  return typeof flags[name] === "string" ? (flags[name] as string) : undefined;
}

export async function runCaptureCli(
  argv: readonly string[],
  io: CaptureCliIo = {},
): Promise<number> {
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  const env = io.env ?? process.env;
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    out(`${CAPTURE_HELP}\n`);
    return 0;
  }
  const spec = SPECS[sub];
  if (!spec) {
    err(`Unknown capture command: ${sub}\n${CAPTURE_HELP}\n`);
    return 1;
  }
  const args = parseCaptureArgs(rest, spec);
  if (args.flags.help) {
    out(`${CAPTURE_HELP}\n`);
    return 0;
  }
  const { flags } = args;
  // Only launch/record run a child command; elsewhere `--` just escapes
  // positional text that starts with dashes (e.g. `capture type -- --foo`).
  const positionals =
    sub === "launch" || sub === "record"
      ? args.positionals
      : [...args.positionals, ...args.command];
  const json = (value: unknown) => out(`${JSON.stringify(value, null, 2)}\n`);
  const need = (count: number, usage: string) => {
    if (positionals.length !== count) throw new Error(`Usage: obsidian-e2e capture ${usage}`);
  };
  const port =
    num(flags, "port") ??
    (env.OBSIDIAN_E2E_CDP_PORT ? Number(env.OBSIDIAN_E2E_CDP_PORT) : undefined);
  const connect = () =>
    connectCapture({ port, timeoutMs: num(flags, "timeout"), window: str(flags, "window") });

  switch (sub) {
    case "launch": {
      const vaultPath = str(flags, "vault");
      if (!vaultPath) throw new Error("capture launch requires --vault <dir>");
      const options = {
        vaultPath,
        root: str(flags, "root"),
        cdpPort: num(flags, "port"),
        scale: num(flags, "scale"),
        screen: str(flags, "screen"),
        obsidianApp: str(flags, "obsidian-app"),
        xvfb: flags.xvfb === true ? true : flags["no-xvfb"] === true ? false : undefined,
        extraArgs: args.command,
        env,
      };
      if (flags["print-env"]) {
        out(captureShellExports(resolveCaptureProfile(options)));
        return 0;
      }
      const profile = await prepareCaptureProfile(options);
      for (const warning of profile.warnings) err(`warning: ${warning}\n`);
      const command = captureLaunchCommand(options, profile);
      err(
        `capture instance: vault=${profile.vaultName} HOME=${profile.home} cdp=${profile.cdpPort}\n`,
      );
      return runCaptureInstance(command, (line) => err(`${line}\n`));
    }
    case "prepare": {
      const theme = str(flags, "theme");
      if (theme !== undefined && theme !== "light" && theme !== "dark") {
        throw new Error("--theme must be light or dark");
      }
      const client = await connect();
      try {
        json(
          await prepareCapture(client, {
            width: num(flags, "width"),
            height: num(flags, "height"),
            scale: num(flags, "scale"),
            theme,
            font: str(flags, "font"),
            css: str(flags, "css"),
            // Omitted flag = leave existing capture CSS alone (size-only prepare).
            hideSecretWarning: flags["hide-secret-warning"] === true ? true : undefined,
          }),
        );
      } finally {
        client.close();
      }
      return 0;
    }
    case "screenshot": {
      need(1, "screenshot <out.png> [--modal|--selector <css>|--rect-js <expr>]");
      const selector = str(flags, "selector");
      const rectJs = str(flags, "rect-js");
      if ([flags.modal === true, selector, rectJs].filter(Boolean).length > 1) {
        throw new Error("Choose one of --modal, --selector, --rect-js");
      }
      const target: ScreenshotTarget = flags.modal
        ? { kind: "modal" }
        : selector
          ? { kind: "selector", selector }
          : rectJs
            ? { kind: "rect", expression: rectJs }
            : { kind: "viewport" };
      const client = await connect();
      try {
        json(
          await captureScreenshot(client, positionals[0]!, {
            target,
            pad: num(flags, "pad"),
            expand: flags.expand === true,
            clean: flags.clean === true,
          }),
        );
      } finally {
        client.close();
      }
      return 0;
    }
    case "type": {
      need(1, "type <text> [--selector <css>] [--delay <ms>]");
      const client = await connect();
      try {
        await typeText(client, positionals[0]!, {
          selector: str(flags, "selector"),
          delayMs: num(flags, "delay"),
          waitMs: num(flags, "wait"),
        });
      } finally {
        client.close();
      }
      return 0;
    }
    case "record":
      need(1, "record <out.webm|out.mp4> [--fps 10] [--cursor] -- <command...>");
      if (args.command.length === 0) throw new Error("capture record needs a command after --");
      return recordAroundCommand(positionals[0]!, args, port, env, json, err);
    case "gif":
      need(2, "gif <in> <out.gif>");
      json(
        await videoToGif(positionals[0]!, positionals[1]!, {
          width: num(flags, "width"),
          fps: num(flags, "fps"),
          colors: num(flags, "colors"),
          lossy: num(flags, "lossy"),
        }),
      );
      return 0;
    case "sheet":
      need(2, "sheet <in> <out.png>");
      json(
        await contactSheet(positionals[0]!, positionals[1]!, {
          every: num(flags, "every"),
          columns: num(flags, "columns"),
          tileWidth: num(flags, "tile-width"),
        }),
      );
      return 0;
    case "probe":
      need(1, "probe <file>");
      json({ path: positionals[0], ...(await probeMedia(positionals[0]!)) });
      return 0;
  }
  return 1;
}

function parseBackend(value: string | undefined): RecordBackend | undefined {
  if (value === undefined || value === "auto" || value === "x11" || value === "screencast") {
    return value;
  }
  throw new Error("--backend must be auto, x11 or screencast");
}

/**
 * Record while a child command drives the UI. The recording is discarded on
 * any failure path - non-zero exit, spawn error, timeout, or SIGINT/SIGTERM -
 * so a partial/corrupt file never looks like a finished take.
 */
async function recordAroundCommand(
  output: string,
  args: CaptureArgs,
  port: number | undefined,
  env: NodeJS.ProcessEnv,
  json: (value: unknown) => void,
  err: (text: string) => void,
): Promise<number> {
  const { flags } = args;
  const cdpPort = port ?? DEFAULT_CDP_PORT;
  const client = await connectCapture({
    port: cdpPort,
    timeoutMs: num(flags, "timeout"),
    window: str(flags, "window"),
  });
  let recording: Awaited<ReturnType<typeof startRecording>> | undefined;
  let killTree: (signal: NodeJS.Signals) => void = () => {};
  // A cancelled take stays cancelled even if the driver traps the signal and exits
  // 0, and cancelling during encoding aborts ffmpeg; handlers stay installed until
  // everything (including temp-frame cleanup) is done.
  let received: NodeJS.Signals | undefined;
  const cancel = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => () => {
    received ??= signal;
    cancel.abort();
    killTree(signal);
    setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS).unref();
  };
  const onInt = onSignal("SIGINT");
  const onTerm = onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  // Read through a function: the signal handler mutates `received`, which
  // control-flow narrowing cannot see after the early-return checks.
  const cancelledBy = (): NodeJS.Signals | undefined => received;
  const signalStatus = (name: NodeJS.Signals) => 128 + (os.constants.signals[name] ?? 15);
  try {
    // Setup (CDP calls, starting ffmpeg) must stay cancellable too: race it
    // against the signal and discard a recording that finishes starting late.
    const starting = startRecording(client, output, {
      fps: num(flags, "fps"),
      quality: num(flags, "quality"),
      cursor: flags.cursor === true,
      keepFrames: flags["keep-failed-frames"] === true,
      backend: parseBackend(str(flags, "backend")),
    });
    const cancelled = new Promise<undefined>((resolve) => {
      if (cancel.signal.aborted) resolve(undefined);
      cancel.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    recording = await Promise.race([starting, cancelled]);
    if (!recording || received) {
      void starting.then((late) => late.abort()).catch(() => {});
      await recording?.abort();
      recording = undefined;
      err(`capture record: cancelled by ${received} before the take started\n`);
      return signalStatus(received ?? "SIGTERM");
    }
    const [file, ...commandArgs] = args.command;
    // Own process group, so a timeout/signal reaches the driver's children too.
    const child = spawn(file!, commandArgs, {
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: { ...env, OBSIDIAN_E2E_CDP_PORT: String(cdpPort) },
    });
    killTree = (signal) => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") {
          process.kill(-child.pid, signal);
        } else child.kill(signal);
      } catch {
        // already gone
      }
    };
    if (received) killTree(received);
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree("SIGTERM");
        // A command that ignores SIGTERM must not keep the recording open.
        setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS).unref();
      },
      (num(flags, "max-seconds") ?? 300) * 1000,
    );
    const status = await new Promise<number>((resolve) => {
      child.on("error", (error) => {
        err(`capture record: failed to run ${file}: ${error.message}\n`);
        resolve(127);
      });
      child.on("close", (code, signal) => {
        if (received) resolve(signalStatus(received));
        else if (timedOut) resolve(124);
        else resolve(signal ? signalStatus(signal) : (code ?? 1));
      });
    }).finally(() => clearTimeout(timer));
    if (status !== 0) {
      killTree("SIGKILL"); // stragglers of a failed/aborted driver
      await recording.abort();
      err(
        `capture record: ${cancelledBy() ? `cancelled by ${cancelledBy()}` : timedOut ? "command timed out" : `command exited ${status}`}; recording discarded\n`,
      );
      return status;
    }
    const current = recording;
    recording = undefined;
    try {
      json(await current.stop({ signal: cancel.signal }));
    } catch (error) {
      const signal = cancelledBy();
      if (!signal) throw error;
      err(`capture record: cancelled by ${signal} while encoding; recording discarded\n`);
      return signalStatus(signal);
    }
    return 0;
  } finally {
    await recording?.abort();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    client.close();
  }
}
