import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { toShellExports, writeJson } from "../runner/fs-utils";
import { stableVaultId } from "../runner/instance";
import { ensureSecureDir } from "../runner/security";

export const DEFAULT_CDP_PORT = 9333;
export const DEFAULT_CAPTURE_SCALE = 2;
export const DEFAULT_XVFB_SCREEN = "3840x3200x24";

/**
 * A dedicated, disposable capture instance: its own HOME/profile, a CDP port,
 * and a forced device scale factor. Deliberately separate from the runner's
 * test instance so capture work never disturbs (or is disturbed by) the
 * start/run/reload lifecycle, and so the DPR is real rather than emulated.
 */
export interface CaptureLaunchOptions {
  /** Existing vault folder to open (e.g. one laid down by `obsidian-e2e provision`). */
  vaultPath: string;
  /** Profile root; defaults to `/tmp/obsidian-e2e-capture-<port>`. */
  root?: string;
  cdpPort?: number;
  scale?: number;
  /** Xvfb screen spec `WxHxDepth`, only used when Xvfb wraps the app. */
  screen?: string;
  /** Obsidian executable (not the CLI). Defaults per platform. */
  obsidianApp?: string;
  /** Wrap in `xvfb-run`. Defaults to Linux without `$DISPLAY`. */
  xvfb?: boolean;
  /** Appended verbatim to the Obsidian argv. */
  extraArgs?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface CaptureProfile {
  root: string;
  home: string;
  userDataPath: string;
  vaultName: string;
  vaultPath: string;
  cdpPort: number;
  warnings: string[];
}

export interface CaptureLaunchCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function defaultObsidianApp(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "/Applications/Obsidian.app/Contents/MacOS/Obsidian"
    : "/opt/Obsidian/obsidian";
}

/** Pure path resolution; no filesystem access. */
export function resolveCaptureProfile(
  options: CaptureLaunchOptions,
): Omit<CaptureProfile, "warnings"> {
  const cdpPort = options.cdpPort ?? DEFAULT_CDP_PORT;
  const root = path.resolve(options.root ?? `/tmp/obsidian-e2e-capture-${cdpPort}`);
  const home = path.join(root, "home");
  const platform = options.platform ?? process.platform;
  const userDataPath =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "obsidian")
      : path.join(home, ".config", "obsidian");
  const vaultPath = path.resolve(options.vaultPath);
  return { root, home, userDataPath, vaultName: path.basename(vaultPath), vaultPath, cdpPort };
}

/**
 * Create the private profile and register the vault as the one open vault (with
 * the CLI enabled so `HOME=<home> obsidian vault=<name> ...` also works). Never
 * writes inside the vault; it only reports vault config that commonly spoils
 * captures.
 */
export async function prepareCaptureProfile(
  options: CaptureLaunchOptions,
): Promise<CaptureProfile> {
  const profile = resolveCaptureProfile(options);
  const stat = await fs.stat(profile.vaultPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Capture vault does not exist: ${profile.vaultPath}`);
  }
  await ensureSecureDir(profile.root);
  await fs.mkdir(profile.userDataPath, { recursive: true, mode: 0o700 });
  await writeJson(
    path.join(profile.userDataPath, "obsidian.json"),
    {
      cli: true,
      updateDisabled: true,
      vaults: {
        [stableVaultId(profile.vaultPath)]: { open: true, path: profile.vaultPath, ts: Date.now() },
      },
    },
    { mode: 0o600 },
  );

  const warnings: string[] = [];
  try {
    const core = JSON.parse(
      await fs.readFile(path.join(profile.vaultPath, ".obsidian", "core-plugins.json"), "utf8"),
    ) as unknown;
    if (Array.isArray(core) && core.length === 0) {
      warnings.push(
        ".obsidian/core-plugins.json is [] (all core plugins off: no command palette, file " +
          "explorer, ...). Delete it before launch if the capture needs them.",
      );
    }
  } catch {
    // absent or unreadable: Obsidian's defaults apply
  }
  return { ...profile, warnings };
}

/** Build the argv; exported so the exact launch shape is unit-testable. */
export function captureLaunchCommand(
  options: CaptureLaunchOptions,
  profile: Pick<CaptureProfile, "home" | "userDataPath" | "cdpPort">,
): CaptureLaunchCommand {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const scale = options.scale ?? DEFAULT_CAPTURE_SCALE;
  const app = options.obsidianApp ?? defaultObsidianApp(platform);
  const appArgs = [
    ...(platform === "linux" ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile.userDataPath}`,
    "--password-store=basic",
    `--remote-debugging-port=${profile.cdpPort}`,
    `--force-device-scale-factor=${scale}`,
    ...(options.extraArgs ?? []),
  ];
  const useXvfb = options.xvfb ?? (platform === "linux" && !env.DISPLAY);
  const childEnv = { ...env, HOME: profile.home };
  if (!useXvfb) return { file: app, args: appArgs, env: childEnv };
  return {
    file: "xvfb-run",
    args: ["-a", "-s", `-screen 0 ${options.screen ?? DEFAULT_XVFB_SCREEN}`, app, ...appArgs],
    env: childEnv,
  };
}

export function captureShellExports(profile: Omit<CaptureProfile, "warnings">): string {
  return `${toShellExports([
    { name: "OBSIDIAN_E2E_CDP_PORT", value: String(profile.cdpPort) },
    { name: "OBSIDIAN_E2E_CAPTURE_HOME", value: profile.home },
    { name: "OBSIDIAN_E2E_CAPTURE_VAULT", value: profile.vaultName },
    { name: "OBSIDIAN_E2E_CAPTURE_VAULT_PATH", value: profile.vaultPath },
  ])}\n`;
}

/**
 * Run the capture instance in the FOREGROUND until it exits, forwarding
 * SIGINT/SIGTERM. Supervise it with whatever keeps processes alive on the host
 * (`amp orb service start`, tmux, a terminal); there is intentionally no
 * detach/reap/reuse logic here - that lifecycle belongs to the runner.
 */
export async function runCaptureInstance(
  command: CaptureLaunchCommand,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const child = spawn(command.file, command.args, { env: command.env, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    return await new Promise<number>((resolve) => {
      child.on("error", (error) => {
        log(`Failed to launch ${command.file}: ${error.message}`);
        resolve(1);
      });
      child.on("close", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
