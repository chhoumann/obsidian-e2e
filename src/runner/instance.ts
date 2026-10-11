import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { errorHasCode, isRecord } from "../core/errors";
import type { ShellExport } from "./fs-utils";
import { safeName, toShellExports, writeJson } from "./fs-utils";
import { ensureSecureDir } from "./security";
import type {
  InstanceMarker,
  InstanceOptions,
  InstanceRawOptions,
  ProfileResult,
  ProvisionOptions,
  ResolvedRunnerConfig,
} from "./types";
import { reconcileSandboxAppAsar, resolveObsidianAppVersion } from "./version-guard";

const DEFAULT_OBSIDIAN_BIN = "obsidian";

/**
 * Sidecar written at the instance root. The teardown reaper reads it to reap an
 * instance only once its backing worktree is gone; the reuse guard compares its
 * recorded `appVersion`. One unified filename across every plugin - each plugin
 * already gets an isolated `profileRoot` (`/tmp/<pluginId>-obsidian-e2e`), so the
 * marker never needs to be namespaced.
 */
export const INSTANCE_MARKER_FILE = "obsidian-e2e-instance.json";

/**
 * Stable per-instance id: a filesystem-safe vault-name prefix (capped at 32
 * chars) plus a 12-hex digest of the resolved worktree path and vault name, so
 * two worktrees provisioning the same vault name never collide.
 */
export function stableInstanceId(worktreePath: string, vaultName: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${path.resolve(worktreePath)}\0${vaultName}`)
    .digest("hex")
    .slice(0, 12);
  return `${safeName(vaultName).slice(0, 32)}-${hash}`;
}

/** Stable 16-hex vault id derived from the resolved vault path (obsidian.json key). */
export function stableVaultId(vaultPath: string): string {
  return crypto.createHash("sha256").update(path.resolve(vaultPath)).digest("hex").slice(0, 16);
}

/**
 * Derive the full {@link InstanceOptions} from already-resolved
 * {@link ProvisionOptions}, the instance-specific raw flags, and the resolved
 * runner config (which supplies the `profileRoot` / `appName` / `obsidianBin`
 * defaults). This intentionally does NOT import the provision module - R5's
 * `ensureObsidianInstance` calls `resolveProvisionOptions` first and threads the
 * result in here, keeping the module graph acyclic. `userDataPath` is set here
 * once so no downstream caller can forget it (the podnotes bug); the profile
 * prep re-returns the same value for a belt-and-braces reassignment.
 */
export function resolveInstanceOptions(
  provision: ProvisionOptions,
  raw: InstanceRawOptions,
  config: ResolvedRunnerConfig,
  cwd: string = process.cwd(),
): InstanceOptions {
  const profileRoot = path.resolve(cwd, raw.profileRoot ?? config.profileRoot);
  const instanceId = stableInstanceId(provision.worktreePath, provision.vaultName);
  const instancePath = path.join(profileRoot, instanceId);
  const obsidianHome = path.join(instancePath, "home");
  const userDataPath = path.join(obsidianHome, "Library", "Application Support", "obsidian");

  return {
    ...provision,
    instanceId,
    instancePath,
    launch: raw.launch ?? true,
    obsidianApp: raw.obsidianApp ?? config.appName,
    obsidianBin: raw.obsidianBin ?? config.obsidianBin,
    obsidianHome,
    profileRoot,
    skipVersionGuard: raw.skipVersionGuard ?? false,
    userDataPath,
  };
}

export interface PrepareProfileOptions extends InstanceOptions {
  /** Injectable version-guard inputs (hermetic tests never touch the host). */
  obsidianConfigDir?: string;
  bundledAsarCandidates?: string[];
  /** Injectable owner uid for the secure-dir guard (foreign-owner branch). */
  currentUid?: number | null;
  /** Injectable host HOME for keychain linking (self-ref guard coverage). */
  realHome?: string;
}

export interface PrepareProfileResult extends ProfileResult {
  /** The predicted app-code version at prepare time (used to seed the sandbox). */
  appVersion: string | null;
}

/**
 * Create and validate the private profile tree, seed the app-code asar the guard
 * predicts, link host keychains, register the vault in `obsidian.json`, and write
 * the worktree marker. The marker's `appVersion` is PRESERVED across re-prepares:
 * it records the LAUNCH-time version (stamped by
 * {@link stampInstanceMarkerAppVersion}), so overwriting it here with a fresh
 * prediction would blind the reuse guard on its next run.
 */
export async function prepareObsidianProfile(
  options: PrepareProfileOptions,
): Promise<PrepareProfileResult> {
  const secureOptions = "currentUid" in options ? { currentUid: options.currentUid } : {};
  // Secure the root before the instance dir so the instance dir is created
  // inside an already-validated 0o700 tree (temp-squat / TOCTOU guard).
  await ensureSecureDir(options.profileRoot, secureOptions);
  await ensureSecureDir(options.instancePath, secureOptions);

  const { userDataPath } = options;
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(options.obsidianHome, "Library", "Logs"), {
    recursive: true,
    mode: 0o700,
  });

  // One resolution feeds BOTH the sandbox seeding and the returned appVersion,
  // so what a fresh instance runs and what the caller reports are the same value.
  const resolvedApp = await resolveObsidianAppVersion({
    obsidianApp: options.obsidianApp,
    obsidianConfigDir: options.obsidianConfigDir,
    bundledAsarCandidates: options.bundledAsarCandidates,
  });
  await reconcileSandboxAppAsar(userDataPath, resolvedApp.newestCachedAsar);
  await linkHostKeychains(options, options.realHome);

  const vaultId = stableVaultId(options.vaultPath);
  const obsidianJsonPath = path.join(userDataPath, "obsidian.json");
  await writeJson(
    obsidianJsonPath,
    {
      cli: true,
      updateDisabled: true,
      vaults: {
        [vaultId]: {
          open: true,
          path: options.vaultPath,
          ts: Date.now(),
        },
      },
    },
    { mode: 0o600 },
  );

  const existingMarker = await readInstanceMarker(options.instancePath);
  await writeInstanceMarker(options.instancePath, {
    worktreePath: options.worktreePath,
    vaultName: options.vaultName,
    vaultPath: options.vaultPath,
    appVersion: existingMarker?.appVersion ?? null,
  });

  return { obsidianJsonPath, userDataPath, vaultId, appVersion: resolvedApp.appVersion };
}

/**
 * Symlink the host keychains into the private HOME so signing/keychain-backed
 * flows work in the sandbox. Self-reference guard: when HOME is already the
 * private profile (the documented `export HOME=$OBSIDIAN_E2E_OBSIDIAN_HOME`),
 * source and destination are the same path - re-linking would replace the real
 * host-keychain symlink with a broken self-referential one, so leave it. The
 * host HOME is injectable so tests can exercise the guard without mutating the
 * process environment.
 */
export async function linkHostKeychains(
  options: { obsidianHome: string },
  realHome: string | undefined = process.env.HOME,
): Promise<void> {
  if (!realHome) return;

  const source = path.join(realHome, "Library", "Keychains");
  const destination = path.join(options.obsidianHome, "Library", "Keychains");
  if (path.resolve(source) === path.resolve(destination)) return;

  try {
    await fs.lstat(source);
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return;
    throw error;
  }

  try {
    const stat = await fs.lstat(destination);
    if (!stat.isSymbolicLink()) return;
    const target = await fs.readlink(destination);
    if (path.resolve(path.dirname(destination), target) === source) return;
    await fs.unlink(destination);
  } catch (error) {
    if (!errorHasCode(error, "ENOENT")) throw error;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.symlink(source, destination);
}

/**
 * Read an instance's marker sidecar; null when absent, unreadable, or not a JSON
 * object (guarded read - a corrupt marker must not throw here).
 */
export async function readInstanceMarker(instancePath: string): Promise<InstanceMarker | null> {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(path.join(instancePath, INSTANCE_MARKER_FILE), "utf8"),
    );
    return isRecord(raw) ? (raw as unknown as InstanceMarker) : null;
  } catch {
    return null;
  }
}

export async function writeInstanceMarker(
  instancePath: string,
  marker: InstanceMarker,
): Promise<void> {
  await writeJson(path.join(instancePath, INSTANCE_MARKER_FILE), marker, { mode: 0o600 });
}

/**
 * Stamp the app-code version the instance was actually LAUNCHED with. Called only
 * after a successful launch - never from profile prep - so the reuse guard keeps
 * seeing the running instance's launch-time version across prepare cycles. A
 * missing marker is a no-op (nothing was prepared to stamp).
 */
export async function stampInstanceMarkerAppVersion(
  instancePath: string,
  appVersion: string | null,
): Promise<void> {
  const marker = await readInstanceMarker(instancePath);
  if (!marker) return;
  await writeInstanceMarker(instancePath, { ...marker, appVersion: appVersion ?? null });
}

export interface InstanceShellExportInput {
  obsidianHome: string;
  obsidianBin?: string;
  /** When set, emit the legacy `<PREFIX>_E2E_OBSIDIAN_HOME` alias during migration. */
  envPrefix?: string;
}

/**
 * Render the instance-level shell exports: the canonical
 * `OBSIDIAN_E2E_OBSIDIAN_HOME`, the optional legacy `<PREFIX>_E2E_OBSIDIAN_HOME`
 * alias, and `OBSIDIAN_BIN` only when a non-default binary was selected (the
 * harnesses read `OBSIDIAN_BIN ?? "obsidian"`). The provision-level
 * `OBSIDIAN_E2E_VAULT*` lines are emitted separately by the provision module.
 */
export function toInstanceShellExports(input: InstanceShellExportInput): string {
  const exports: ShellExport[] = [
    { name: "OBSIDIAN_E2E_OBSIDIAN_HOME", value: input.obsidianHome },
  ];
  if (input.envPrefix) {
    exports.push({ name: `${input.envPrefix}_E2E_OBSIDIAN_HOME`, value: input.obsidianHome });
  }
  if (input.obsidianBin && input.obsidianBin !== DEFAULT_OBSIDIAN_BIN) {
    exports.push({ name: "OBSIDIAN_BIN", value: input.obsidianBin });
  }
  return toShellExports(exports);
}
