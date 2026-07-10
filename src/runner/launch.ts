import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { commandErrorMessage } from "../core/errors";
import { ensureSecureDir } from "./security";
import type { ReadyProbe } from "./types";

const execFileAsync = promisify(execFileCb);

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 500;
const READY_PROBE_TIMEOUT_MS = 5_000;
const CLI_SOCKET_FILE = ".obsidian-cli.sock";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export interface ExecFileRunOptions {
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  timeout?: number;
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: ExecFileRunOptions,
) => Promise<ExecFileResult>;

/**
 * All side effects the launcher performs are injected through this object so the
 * whole module is testable with fakes: `execFile` (the child-process boundary),
 * `socketExists` (the CLI-socket probe), and the timing primitives plus the poll
 * bounds (`timeoutMs`/`intervalMs`) so timeout paths run instantly under test.
 */
export interface ObsidianExecDependencies {
  execFile?: ExecFileFn;
  socketExists?: (socketPath: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  /** Injectable owner uid for the launch-time secure-dir guard. */
  currentUid?: number | null;
}

export interface ObsidianExecTarget {
  obsidianBin: string;
  obsidianHome: string;
}

export interface VaultExecTarget extends ObsidianExecTarget {
  vaultName: string;
}

export interface InstanceReadyTarget extends VaultExecTarget {
  vaultPath: string;
}

export interface LaunchTarget {
  obsidianApp: string;
  obsidianHome: string;
  userDataPath: string;
  profileRoot: string;
  instancePath: string;
}

const defaultExecFile: ExecFileFn = async (file, args, options = {}) => {
  const { stdout, stderr } = (await execFileAsync(file, [...args], {
    encoding: "utf8",
    env: options.env,
    timeout: options.timeout,
  })) as { stdout: string; stderr: string };
  return { stdout, stderr };
};

const defaultSocketExists = async (socketPath: string): Promise<boolean> => {
  try {
    await fs.lstat(socketPath);
    return true;
  } catch {
    return false;
  }
};

function resolveExec(deps?: ObsidianExecDependencies): ExecFileFn {
  return deps?.execFile ?? defaultExecFile;
}

function resolveSocketExists(
  deps?: ObsidianExecDependencies,
): (socketPath: string) => Promise<boolean> {
  return deps?.socketExists ?? defaultSocketExists;
}

function resolveNow(deps?: ObsidianExecDependencies): () => number {
  return deps?.now ?? Date.now;
}

function resolveSleep(deps?: ObsidianExecDependencies): (ms: number) => Promise<void> {
  return deps?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function obsidianEnv(target: { obsidianHome: string }): NodeJS.ProcessEnv {
  return { ...process.env, HOME: target.obsidianHome };
}

/** Run the `obsidian` CLI against the isolated HOME, UTF-8 decoded. */
export async function execObsidian(
  target: ObsidianExecTarget,
  args: readonly string[],
  deps?: ObsidianExecDependencies,
  execOptions: ExecFileRunOptions = {},
): Promise<ExecFileResult> {
  return resolveExec(deps)(target.obsidianBin, args, {
    encoding: "utf8",
    env: obsidianEnv(target),
    ...execOptions,
  });
}

export function cliSocketPath(target: { obsidianHome: string }): string {
  return path.join(target.obsidianHome, CLI_SOCKET_FILE);
}

/**
 * Whether the `obsidian-cli` unix socket exists for this private HOME. Its
 * presence means an instance is up (or starting to listen); its absence means
 * "not running" - probing anyway would make the CLI auto-launch a competing
 * instance on the cold HOME.
 */
export async function cliSocketExists(
  target: { obsidianHome: string },
  deps?: ObsidianExecDependencies,
): Promise<boolean> {
  return resolveSocketExists(deps)(cliSocketPath(target));
}

/**
 * Launch a fresh detached, backgrounded Obsidian bound to the isolated HOME.
 * Re-validates the profile tree first (parent-first) so any future relaunch path
 * that skips the normal preflight still cannot bypass the temp-squat guard.
 */
export async function launchObsidianInstance(
  target: LaunchTarget,
  deps?: ObsidianExecDependencies,
): Promise<void> {
  const secureOptions = deps && "currentUid" in deps ? { currentUid: deps.currentUid } : {};
  await ensureSecureDir(target.profileRoot, secureOptions);
  await ensureSecureDir(target.instancePath, secureOptions);

  await resolveExec(deps)(
    "/usr/bin/open",
    [
      "-n",
      "-g",
      "-a",
      target.obsidianApp,
      "--env",
      `HOME=${target.obsidianHome}`,
      "--args",
      `--user-data-dir=${target.userDataPath}`,
      "--password-store=basic",
    ],
    { env: obsidianEnv(target) },
  );
}

/**
 * Socket-gated readiness probe. Returns false without issuing any CLI command
 * when the socket is absent (the double-launch-race guard), otherwise reports
 * whether the running instance serves the expected vault path.
 */
export async function isInstanceReady(
  target: InstanceReadyTarget,
  deps?: ObsidianExecDependencies,
): Promise<boolean> {
  if (!(await cliSocketExists(target, deps))) return false;
  try {
    const { stdout } = await execObsidian(
      target,
      [`vault=${target.vaultName}`, "vault", "info=path"],
      deps,
      { timeout: READY_PROBE_TIMEOUT_MS },
    );
    return path.resolve(stdout.trim()) === path.resolve(target.vaultPath);
  } catch {
    return false;
  }
}

/**
 * Poll until the just-launched instance serves the expected vault path, returning
 * the resolved path. Socket-gated: never issues a CLI command before the instance
 * is listening on its socket, so a probe cannot race a second `open -n` launch.
 */
export async function waitForInstanceReady(
  target: InstanceReadyTarget,
  deps?: ObsidianExecDependencies,
): Promise<string> {
  const expectedPath = path.resolve(target.vaultPath);
  const now = resolveNow(deps);
  const sleep = resolveSleep(deps);
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const intervalMs = deps?.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const deadline = now() + timeoutMs;
  let lastError = "";

  while (now() < deadline) {
    if (!(await cliSocketExists(target, deps))) {
      lastError = "waiting for the obsidian-cli socket to appear";
      await sleep(intervalMs);
      continue;
    }
    try {
      const { stdout } = await execObsidian(
        target,
        [`vault=${target.vaultName}`, "vault", "info=path"],
        deps,
      );
      const actualPath = path.resolve(stdout.trim());
      if (actualPath === expectedPath) return actualPath;
      lastError = `resolved ${actualPath}, expected ${expectedPath}`;
    } catch (error) {
      lastError = commandErrorMessage(error);
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Obsidian instance did not become ready for ${target.vaultName}. Last error: ${lastError}`,
  );
}

/**
 * Reload the plugin so a reused warm instance picks up a rebuilt `main.js`
 * instead of serving the bundle it loaded earlier.
 */
export async function reloadPlugin(
  target: VaultExecTarget,
  pluginId: string,
  deps?: ObsidianExecDependencies,
): Promise<void> {
  await execObsidian(
    target,
    [`vault=${target.vaultName}`, "plugin:reload", `id=${pluginId}`],
    deps,
  );
}

/**
 * Disable Restricted Mode, then poll the configured readiness probe until its
 * output contains `probe.match`. An `eval` probe runs `code=<probe.code>`; a
 * `command` probe forwards `probe.args` verbatim. The probe code/args never embed
 * the match sentinel, so an echoed command can't be mistaken for a positive.
 */
export async function trustVaultAndVerifyPlugin(
  target: VaultExecTarget,
  readyProbe: ReadyProbe,
  deps?: ObsidianExecDependencies,
): Promise<boolean> {
  await execObsidian(target, [`vault=${target.vaultName}`, "plugins:restrict", "off"], deps);

  const now = resolveNow(deps);
  const sleep = resolveSleep(deps);
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const intervalMs = deps?.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const probeArgs =
    readyProbe.kind === "eval"
      ? [`vault=${target.vaultName}`, "eval", `code=${readyProbe.code}`]
      : [`vault=${target.vaultName}`, ...readyProbe.args];

  const deadline = now() + timeoutMs;
  let lastError = "";
  while (now() < deadline) {
    try {
      const { stdout } = await execObsidian(target, probeArgs, deps);
      if (stdout.includes(readyProbe.match)) return true;
      lastError = stdout.trim();
    } catch (error) {
      lastError = commandErrorMessage(error);
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Plugin did not become available in ${target.vaultName}. Last error: ${lastError}`,
  );
}
