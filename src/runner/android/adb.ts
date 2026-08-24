import { spawn as realSpawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { commandErrorMessage } from "../../core/errors";
import type { ExecFileFn } from "../launch";
import type { ResolvedAndroidConfig } from "../types";

/** The Obsidian Android application id; fixed, unlike the desktop app name. */
export const OBSIDIAN_PACKAGE = "md.obsidian";

const BOOT_POLL_INTERVAL_MS = 2_000;

/**
 * The process/timing boundary every adb helper runs through, injected so the
 * whole module is table-testable with fakes. `spawnDetached` exists because the
 * emulator is the one child that must outlive us (fire-and-forget with its
 * output redirected to a log file); everything else is a bounded `execFile`.
 */
export interface AdbDependencies {
  execFile: ExecFileFn;
  spawnDetached?: (file: string, args: readonly string[], logPath: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AdbTarget {
  adbBin: string;
  serial: string;
}

const defaultSpawnDetached = async (
  file: string,
  args: readonly string[],
  logPath: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const log = await fs.open(logPath, "a");
  try {
    const child = realSpawn(file, [...args], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
  } finally {
    await log.close();
  }
};

function resolveDeps(deps: AdbDependencies) {
  return {
    execFile: deps.execFile,
    spawnDetached: deps.spawnDetached ?? defaultSpawnDetached,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
}

/** Run `adb -s <serial> <args>` and return trimmed stdout. */
export async function adb(
  target: AdbTarget,
  args: readonly string[],
  deps: AdbDependencies,
  timeout = 30_000,
): Promise<string> {
  const { stdout } = await deps.execFile(target.adbBin, ["-s", target.serial, ...args], {
    timeout,
  });
  return stdout.trim();
}

/** Run `adb -s <serial> shell <command>` and return trimmed stdout. */
export function adbShell(
  target: AdbTarget,
  command: string,
  deps: AdbDependencies,
  timeout = 30_000,
): Promise<string> {
  return adb(target, ["shell", command], deps, timeout);
}

/**
 * Find the online emulator serial running the configured AVD, or null. Serials
 * are assigned dynamically (`emulator-5554`, `-5556`, ...), so the only stable
 * identity is the AVD name each emulator reports over `adb emu avd name`.
 */
export async function findEmulatorSerial(
  config: ResolvedAndroidConfig,
  deps: AdbDependencies,
): Promise<string | null> {
  const { execFile } = resolveDeps(deps);
  let stdout: string;
  try {
    ({ stdout } = await execFile(config.adbBin, ["devices"], { timeout: 15_000 }));
  } catch (error) {
    throw new Error(
      `Cannot run ${config.adbBin} devices: ${commandErrorMessage(error)}. ` +
        `Install Android platform-tools and put adb on PATH (or set android.adbBin).`,
    );
  }

  for (const line of stdout.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (!serial || state !== "device" || !serial.startsWith("emulator-")) continue;
    const name = await adb({ adbBin: config.adbBin, serial }, ["emu", "avd", "name"], deps).catch(
      () => "",
    );
    // `adb emu avd name` prints the name and a trailing "OK" line.
    if (name.split("\n")[0]?.trim() === config.avd) return serial;
  }
  return null;
}

/**
 * Ensure the configured AVD is booted and return its serial: reuse a running
 * emulator or launch one headless (detached; log at `<logDir>/emulator.log`)
 * and poll `sys.boot_completed` until the boot timeout.
 */
export async function ensureEmulator(
  config: ResolvedAndroidConfig,
  logDir: string,
  deps: AdbDependencies,
  log: (message: string) => void = () => {},
): Promise<string> {
  const { spawnDetached, now, sleep } = resolveDeps(deps);

  const running = await findEmulatorSerial(config, deps);
  if (running) return running;

  log(`Launching Android emulator for AVD "${config.avd}" (headless).`);
  await spawnDetached(
    config.emulatorBin,
    ["-avd", config.avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot"],
    path.join(logDir, "emulator.log"),
  );

  const deadline = now() + config.bootTimeoutMs;
  while (now() < deadline) {
    const serial = await findEmulatorSerial(config, deps);
    if (serial) {
      const booted = await adbShell(
        { adbBin: config.adbBin, serial },
        "getprop sys.boot_completed",
        deps,
      ).catch(() => "");
      if (booted === "1") return serial;
    }
    await sleep(BOOT_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Android emulator for AVD "${config.avd}" did not boot within ${config.bootTimeoutMs}ms. ` +
      `See ${path.join(logDir, "emulator.log")}.`,
  );
}

/** Whether the Obsidian app is installed on the device. */
export async function isAppInstalled(target: AdbTarget, deps: AdbDependencies): Promise<boolean> {
  const out = await adbShell(target, `pm path ${OBSIDIAN_PACKAGE}`, deps).catch(() => "");
  return out.includes("package:");
}

/** Install the Obsidian APK; the emulator accepts unsigned-source installs as-is. */
export async function installApk(
  target: AdbTarget,
  apkPath: string,
  deps: AdbDependencies,
): Promise<void> {
  const out = await adb(target, ["install", "-r", apkPath], deps, 180_000);
  if (!out.includes("Success")) {
    throw new Error(`adb install ${apkPath} failed: ${out}`);
  }
}

/**
 * Restart adbd as root, required to write into the app's external-storage vault
 * dir. Only AOSP/google_apis emulator images are rootable - a Play-Store image
 * fails here with a clear error. Restarting adbd drops all port forwards, so
 * callers must (re-)forward AFTER this.
 */
export async function ensureAdbRoot(target: AdbTarget, deps: AdbDependencies): Promise<void> {
  const { sleep } = resolveDeps(deps);
  const out = await adb(target, ["root"], deps, 30_000).catch((error) => {
    throw new Error(`adb root failed: ${commandErrorMessage(error)}`);
  });
  if (out.includes("cannot run as root")) {
    throw new Error(
      `The AVD "${target.serial}" refuses adb root. Use a google_apis (non-Play-Store) ` +
        `system image for the E2E AVD; Play-Store images are not rootable.`,
    );
  }
  // adbd restarts; wait for the device to come back before the next command.
  await sleep(1_000);
  await adb(target, ["wait-for-device"], deps, 30_000);
}

/** The uid the app's files must be owned by for the webview to read them. */
export async function appUid(target: AdbTarget, deps: AdbDependencies): Promise<string> {
  const uid = await adbShell(target, `stat -c %u /data/data/${OBSIDIAN_PACKAGE}`, deps);
  if (!/^\d+$/.test(uid)) {
    throw new Error(`Cannot resolve the ${OBSIDIAN_PACKAGE} uid (stat printed "${uid}").`);
  }
  return uid;
}

/** The pid of the running Obsidian app, or null. */
export async function appPid(target: AdbTarget, deps: AdbDependencies): Promise<string | null> {
  const pid = await adbShell(target, `pidof ${OBSIDIAN_PACKAGE}`, deps).catch(() => "");
  return /^\d+$/.test(pid) ? pid : null;
}

/**
 * Launch the app and wait until its webview devtools socket is up (Obsidian
 * mobile ships with webview debugging enabled - that socket is the whole
 * remote-control surface). Returns the app pid the socket is named after.
 */
export async function startApp(
  target: AdbTarget,
  deps: AdbDependencies,
  timeoutMs = 60_000,
): Promise<string> {
  const { now, sleep } = resolveDeps(deps);
  await adbShell(target, `am start -n ${OBSIDIAN_PACKAGE}/.MainActivity`, deps);

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const pid = await appPid(target, deps);
    if (pid) {
      const sockets = await adbShell(target, "cat /proc/net/unix", deps).catch(() => "");
      if (sockets.includes(`webview_devtools_remote_${pid}`)) return pid;
    }
    await sleep(1_000);
  }
  throw new Error(
    `Obsidian did not expose its webview devtools socket within ${timeoutMs}ms on ${target.serial}.`,
  );
}

/** Forward the host CDP port to the app's webview devtools socket. */
export async function forwardCdp(
  target: AdbTarget,
  pid: string,
  cdpPort: number,
  deps: AdbDependencies,
): Promise<void> {
  await adb(
    target,
    ["forward", `tcp:${cdpPort}`, `localabstract:webview_devtools_remote_${pid}`],
    deps,
  );
}

/** Force-stop the app, then shut the whole emulator down. */
export async function stopEmulator(target: AdbTarget, deps: AdbDependencies): Promise<void> {
  await adbShell(target, `am force-stop ${OBSIDIAN_PACKAGE}`, deps).catch(() => {});
  await adb(target, ["emu", "kill"], deps).catch(() => {});
}
