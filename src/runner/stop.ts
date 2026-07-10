import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { errorHasCode, isRecord } from "../core/errors";
import { pathExists } from "./fs-utils";
import { assertSecureDirIfPresent } from "./security";
import type {
  CollectInstanceOptions,
  InstanceReadDependencies,
  KillFunction,
  ProcessInfo,
  ReapOptions,
  ReapResult,
  StopOptions,
  StopResult,
} from "./types";

const execFileAsync = promisify(execFile);

// Window we give a SIGTERM'd Obsidian tree to exit cleanly before escalating to
// SIGKILL. Electron tears down its helper processes in well under a second.
export const TERM_GRACE_MS = 3_000;
export const TERM_POLL_MS = 100;

// Every per-worktree instance dir is `<profile-root>/<vaultName>-<12 hex>` (see
// stableInstanceId in instance.ts). The trailing hash makes the dir name
// globally unique and is the guard that stops us ever removing a non-instance
// directory (the shared dev vault, another plugin's profile, `/tmp`, ...).
export const INSTANCE_DIR_PATTERN = /-[0-9a-f]{12}$/;

/**
 * Reap options plus the marker filename to check for orphan detection. The
 * filename is plugin-specific (`${pluginId}-e2e-instance.json`), so it is passed
 * in rather than hard-coded.
 */
export interface ReapInstancesOptions extends ReapOptions {
  markerFile: string;
}

// macOS firmlinks /tmp, /var, and /etc under /private. Obsidian's main process
// keeps the literal `--user-data-dir` we pass (e.g. /tmp/...), while Electron
// canonicalizes the same flag to /private/tmp/... for its helper processes.
// Strip a leading /private so one instance path matches the whole process tree.
function stripPrivatePrefix(value: string): string {
  return value.replace(/^\/private(?=\/)/, "");
}

export function commandMatchesInstance(command: string, instancePath: string): boolean {
  const stripped = stripPrivatePrefix(instancePath);
  const variants = new Set([instancePath, stripped, stripped.replace(/^\//, "/private/")]);
  // Seed only on the Obsidian `--user-data-dir=` flag whose value is THIS
  // instance's profile dir (with a trailing separator). Scoping to the flag, not
  // a bare substring, means an unrelated process that merely mentions the path -
  // a log tail, an editor, a grep - is never pulled into the kill set. The
  // trailing slash stops a sibling whose id shares this one as a leading string.
  return [...variants].some((variant) => command.includes(`--user-data-dir=${variant}/`));
}

export function parsePsOutput(stdout: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3] as string,
    });
  }
  return processes;
}

// Returns the pids of the Obsidian process tree bound to `instancePath`: the
// seed processes whose argv references the instance profile, plus every
// descendant. The descendant walk is belt-and-suspenders - Electron helpers
// already carry --user-data-dir, but this also reaps any grandchild a helper
// spawned that does not echo the flag.
export function collectInstancePids(
  processes: readonly ProcessInfo[],
  instancePath: string,
  options: CollectInstanceOptions = {},
): number[] {
  const selfPid = options.selfPid ?? process.pid;
  const childrenByParent = new Map<number, ProcessInfo[]>();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ppid) ?? [];
    siblings.push(proc);
    childrenByParent.set(proc.ppid, siblings);
  }

  const collected = new Set<number>();
  const stack = processes
    .filter((proc) => commandMatchesInstance(proc.command, instancePath))
    .map((proc) => proc.pid);
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) continue;
    if (collected.has(pid)) continue;
    collected.add(pid);
    for (const child of childrenByParent.get(pid) ?? []) {
      stack.push(child.pid);
    }
  }

  // Never signal ourselves, init, or the kernel - defensive, the token would not
  // match these anyway.
  for (const guarded of [selfPid, 0, 1]) collected.delete(guarded);
  return [...collected].sort((a, b) => a - b);
}

function assertSafeInstancePath(instancePath: string, profileRoot: string | undefined): void {
  if (!instancePath || !path.isAbsolute(instancePath)) {
    throw new Error(`Refusing to remove non-absolute instance path: ${instancePath}`);
  }
  const base = path.basename(instancePath);
  if (!INSTANCE_DIR_PATTERN.test(base)) {
    throw new Error(`Refusing to remove ${instancePath}: not an Obsidian E2E instance directory.`);
  }
  // A real instance dir is several levels deep (e.g. /tmp/<plugin>-obsidian-e2e/<id>);
  // reject anything shallow enough to be a system root.
  if (instancePath.split(path.sep).filter(Boolean).length < 2) {
    throw new Error(`Refusing to remove shallow path: ${instancePath}`);
  }
  // Containment guard: when the caller knows the profile root, the dir we remove
  // must be a direct child of it. Real callers always do, so a bad --profile-root
  // can never make us rm a path outside the e2e profile tree.
  if (profileRoot && path.resolve(path.dirname(instancePath)) !== path.resolve(profileRoot)) {
    throw new Error(
      `Refusing to remove ${instancePath}: not a direct child of profile root ${profileRoot}.`,
    );
  }
}

async function defaultRunPs(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,ppid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function pidAlive(pid: number, kill: KillFunction): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else; for our own
    // instances that should not happen, but treat it as alive to be safe. ESRCH
    // means it is gone. Any other failure (e.g. EIO) is unexpected: rethrow so a
    // probe we cannot trust never lets us delete the profile of a live process.
    if (errorHasCode(error, "EPERM")) return true;
    if (errorHasCode(error, "ESRCH")) return false;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// kill(2) errors we tolerate so one stubborn pid never aborts tearing down the
// rest of the tree (and never blocks the subsequent dir removal): ESRCH (already
// exited between discovery and signalling), EPERM (a pid we no longer own - e.g.
// recycled by a foreign process; skip rather than touch it), ENOENT (defensive).
export const IGNORABLE_KILL_CODES = new Set(["ESRCH", "EPERM", "ENOENT"]);

function isIgnorableKillError(error: unknown): boolean {
  return [...IGNORABLE_KILL_CODES].some((code) => errorHasCode(error, code));
}

function signalPids(pids: readonly number[], signal: NodeJS.Signals, kill: KillFunction): number[] {
  const signalled: number[] = [];
  for (const pid of pids) {
    try {
      kill(pid, signal);
      signalled.push(pid);
    } catch (error) {
      if (!isIgnorableKillError(error)) throw error;
    }
  }
  return signalled;
}

// setTimeout-based polling needs a monotonic clock; Date.now is adequate here and
// keeps the helper trivially mockable in tests via the injected clock.
function monotonicNow(): number {
  return Date.now();
}

// Stop a single instance: terminate its process tree (SIGTERM, then SIGKILL for
// stragglers) and remove its profile directory. Safe to call when nothing is
// running - it then just removes a leftover directory. All side effects are
// injectable so the orchestration is unit-testable without real processes.
export async function stopInstance(
  instancePath: string,
  options: StopOptions = {},
): Promise<StopResult> {
  const {
    dryRun = false,
    kill = process.kill.bind(process),
    runPs = defaultRunPs,
    removeDir = (dir: string) => fs.rm(dir, { recursive: true, force: true }),
    selfPid = process.pid,
    graceMs = TERM_GRACE_MS,
    pollMs = TERM_POLL_MS,
    profileRoot,
  } = options;

  assertSafeInstancePath(instancePath, profileRoot);

  const processes = parsePsOutput(await runPs());
  const pids = collectInstancePids(processes, instancePath, { selfPid });

  if (dryRun) {
    return { instancePath, pids, terminated: [], killed: [], removed: false };
  }

  signalPids(pids, "SIGTERM", kill);

  // Recheck liveness at least once after SIGTERM before escalating: a `do/while`
  // (not a `while`) guarantees the recheck runs even when `graceMs` is 0 or has
  // already elapsed, so a process that exits right after SIGTERM is never
  // needlessly SIGKILLed.
  let survivors = pids;
  if (survivors.length > 0) {
    const deadline = monotonicNow() + graceMs;
    do {
      await sleep(pollMs);
      survivors = survivors.filter((pid) => pidAlive(pid, kill));
    } while (survivors.length > 0 && monotonicNow() < deadline);
  }
  const killed = survivors.length > 0 ? signalPids(survivors, "SIGKILL", kill) : [];

  await removeDir(instancePath);

  return { instancePath, pids, terminated: pids, killed, removed: true };
}

// Reads the vault paths an instance registered in its private obsidian.json.
// Returns null when the registration is unreadable (so callers can stay
// conservative and not reap an instance they cannot reason about).
export async function readInstanceVaultPaths(
  instancePath: string,
  deps: InstanceReadDependencies = {},
): Promise<string[] | null> {
  const readFile = deps.readFile ?? ((file: string) => fs.readFile(file, "utf8"));
  const jsonPath = path.join(
    instancePath,
    "home",
    "Library",
    "Application Support",
    "obsidian",
    "obsidian.json",
  );
  try {
    const parsed: unknown = JSON.parse(await readFile(jsonPath));
    if (!isRecord(parsed) || !isRecord(parsed.vaults)) return null;

    const vaultPaths: string[] = [];
    for (const vault of Object.values(parsed.vaults)) {
      if (isRecord(vault) && typeof vault.path === "string") {
        vaultPaths.push(vault.path);
      }
    }
    return vaultPaths;
  } catch {
    return null;
  }
}

// Reads the instance marker that start writes (worktreePath/vaultName/vaultPath).
// Returns null when it is missing/unreadable so callers can fall back.
export async function readInstanceMarker(
  instancePath: string,
  markerFile: string,
  deps: InstanceReadDependencies = {},
): Promise<Record<string, unknown> | null> {
  const readFile = deps.readFile ?? ((file: string) => fs.readFile(file, "utf8"));
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(instancePath, markerFile)));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// An instance is "orphaned" once the worktree it belongs to is gone from disk -
// the signature of a worktree removed on merge. We reap it even if its Obsidian
// process is still running: a leaked-but-running instance is exactly what must be
// cleaned up. We do NOT use "no process running" or "a single vault leaf missing"
// as the signal - an idle-but-valid instance for a live worktree, or a vault on a
// momentarily-unmounted volume, must survive. The worktree path is read from the
// marker; pre-marker instances fall back to "every registered vault path is gone".
export async function isInstanceOrphaned(
  instancePath: string,
  markerFile: string,
  deps: InstanceReadDependencies = {},
): Promise<boolean> {
  const exists = deps.exists ?? pathExists;
  const marker = await readInstanceMarker(instancePath, markerFile, deps);
  if (marker && typeof marker.worktreePath === "string") {
    return !(await exists(marker.worktreePath));
  }
  const vaultPaths = await readInstanceVaultPaths(instancePath, deps);
  if (vaultPaths === null || vaultPaths.length === 0) return false;
  for (const vaultPath of vaultPaths) {
    if (await exists(vaultPath)) return false;
  }
  return true;
}

// Scans the profile root and tears down every orphaned instance. Used as a
// self-healing safety net on the next `start` so leaks survive even when a
// worktree is removed without the orca archive hook.
export async function reapOrphanedInstances(options: ReapInstancesOptions): Promise<ReapResult> {
  const {
    profileRoot,
    markerFile,
    exceptInstancePath,
    dryRun = false,
    log = () => {},
    readdir = (dir: string) => fs.readdir(dir, { withFileTypes: true }),
    ...deps
  } = options;

  if (!profileRoot) return { scanned: 0, reaped: [] };

  // Refuse to scan/remove through a hijacked or symlinked profile root (the same
  // temp-squat guard the start path applies before writing into it). An absent
  // root just means there is nothing to reap; an insecure one is reported and
  // skipped rather than thrown, so a poisoned root never aborts the start it
  // guards.
  let secure: boolean;
  try {
    secure = await assertSecureDirIfPresent(profileRoot);
  } catch (error) {
    log(
      `Refusing to reap under insecure profile root ${profileRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { scanned: 0, reaped: [] };
  }
  if (!secure) return { scanned: 0, reaped: [] };

  let entries;
  try {
    entries = await readdir(profileRoot);
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return { scanned: 0, reaped: [] };
    throw error;
  }

  const reaped: string[] = [];
  let scanned = 0;
  const except = exceptInstancePath ? path.resolve(exceptInstancePath) : null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !INSTANCE_DIR_PATTERN.test(entry.name)) continue;
    const instancePath = path.join(profileRoot, entry.name);
    if (except && path.resolve(instancePath) === except) continue;
    scanned += 1;
    if (!(await isInstanceOrphaned(instancePath, markerFile, deps))) continue;
    log(`Reaping orphaned E2E instance ${entry.name} (worktree is gone).`);
    if (dryRun) {
      reaped.push(instancePath);
      continue;
    }
    // Isolate each teardown so one stubborn orphan (e.g. a permission error)
    // never aborts reaping the rest of the scan.
    try {
      await stopInstance(instancePath, { ...deps, profileRoot, dryRun: false });
      reaped.push(instancePath);
    } catch (error) {
      log(
        `Failed to reap ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { scanned, reaped };
}
