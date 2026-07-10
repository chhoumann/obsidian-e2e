import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isRecord } from "../core/errors";

const DEFAULT_OBSIDIAN_APP = "Obsidian";

/**
 * Obsidian ships TWO versions: the installer shell (the `.app`, shown in the
 * window title) and the auto-updated app code (`obsidian-<version>.asar`, the
 * `apiVersion` plugins actually see). `minAppVersion` is enforced against the
 * app-code version. A launched instance resolves that asar from the config dir
 * of the HOME it runs under - for this harness the ISOLATED sandbox home - so a
 * fresh sandbox silently boots the older bundled installer build unless we seed
 * it (see {@link reconcileSandboxAppAsar}). This guard resolves the app-code
 * version from disk (the running renderer cannot report it) and fails loud when
 * it is below the plugin's `minAppVersion`, turning a false "missing API" e2e
 * signal into an explicit, actionable error.
 */
export const OBSIDIAN_ASAR_VERSION_RE = /^obsidian-(\d+\.\d+\.\d+)\.asar$/;

/** The newest valid cached asar in the config dir - the single seeding authority. */
export interface CachedAsar {
  name: string;
  path: string;
  version: string;
}

export interface ResolveAppVersionOptions {
  obsidianApp?: string;
  /** Injectable so tests never scan the real host config dir. */
  obsidianConfigDir?: string;
  /** Injectable so tests never read a real ~25MB installer asar. */
  bundledAsarCandidates?: string[];
}

export interface ResolvedAppVersion {
  appVersion: string | null;
  installerVersion: string | null;
  cachedVersions: string[];
  configDir: string;
  newestCachedAsar: CachedAsar | null;
}

export interface MinAppVersionOptions extends ResolveAppVersionOptions {
  worktreePath: string;
}

export interface MinAppVersionResult {
  appVersion: string;
  installerVersion: string | null;
  minAppVersion: string;
}

export function macObsidianConfigDir(): string {
  return path.join(os.userInfo().homedir, "Library", "Application Support", "obsidian");
}

/**
 * Standard install locations only, consulted as the floor when the config dir
 * has no usable cached asar (a fresh machine / CI that never auto-updated). A
 * bundle registered elsewhere with an empty cache resolves to null and the
 * guard then refuses to run blind rather than guess.
 */
export function bundledAsarCandidates(obsidianApp: string): string[] {
  const leaf = path.join(`${obsidianApp}.app`, "Contents", "Resources", "obsidian.asar");
  return [path.join("/Applications", leaf), path.join(os.userInfo().homedir, "Applications", leaf)];
}

/** Numeric 3-part compare; ignores any pre-release suffix. >0 if a>b, 0, <0. */
export function compareObsidianVersions(a: string, b: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  };
  const x = parse(a);
  const y = parse(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * Read `version` from an asar archive's `package.json` without unpacking it.
 * Returns null on any malformed/missing input (never throws) so a stray file in
 * the config dir cannot break the guard.
 *
 * asar layout: `[size pickle (8 bytes)] [header pickle] [file data]`. The size
 * pickle's payload (byte 4, UInt32LE) is the header pickle's byte length, so
 * file data begins at `8 + headerPickleLength`. The header pickle wraps a Pickle
 * string: its raw length is at byte 12 and its JSON bytes start at byte 16.
 * Pickle 4-byte-aligns the string, so the data base must come from the header
 * pickle length, NOT `16 + jsonLength` (which lands in the alignment padding
 * whenever the JSON length is not a multiple of 4).
 */
export async function readAsarPackageVersion(asarPath: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(asarPath, "r");
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
    const headerPickleLength = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    if (!Number.isInteger(jsonLength) || jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) {
      return null;
    }
    const dataBase = 8 + headerPickleLength;
    const headerBuf = Buffer.alloc(jsonLength);
    await handle.read(headerBuf, 0, jsonLength, 16);
    const header: unknown = JSON.parse(headerBuf.toString("utf8"));
    const files = isRecord(header) ? header.files : undefined;
    const entry = isRecord(files) ? files["package.json"] : undefined;
    if (!isRecord(entry)) return null;
    const size = Number(entry.size);
    const offset = Number(entry.offset);
    if (!Number.isFinite(size) || !Number.isFinite(offset) || size <= 0) return null;
    const fileBuf = Buffer.alloc(size);
    await handle.read(fileBuf, 0, size, dataBase + offset);
    const parsed: unknown = JSON.parse(fileBuf.toString("utf8"));
    const version = isRecord(parsed) ? parsed.version : undefined;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Resolve the Obsidian app-code version the launched instance runs: the newest
 * valid installed `obsidian-*.asar` in the real config dir, floored at the
 * bundled installer asar. `appVersion` is null when no version can be determined
 * at all. `newestCachedAsar` is the single authority the seeding step copies, so
 * the guard's prediction and the seeded sandbox cannot diverge by construction.
 */
export async function resolveObsidianAppVersion(
  options: ResolveAppVersionOptions = {},
): Promise<ResolvedAppVersion> {
  const obsidianApp = options.obsidianApp ?? DEFAULT_OBSIDIAN_APP;
  const configDir = options.obsidianConfigDir ?? macObsidianConfigDir();

  const cachedVersions: string[] = [];
  let newestCachedAsar: CachedAsar | null = null;
  try {
    for (const name of await fs.readdir(configDir)) {
      if (!OBSIDIAN_ASAR_VERSION_RE.test(name)) continue;
      // Trust the asar's own package.json, not the filename: a partial/corrupt
      // download parses to null and is skipped (Obsidian would not load it
      // either), so a half-downloaded obsidian-<newer>.asar cannot make the
      // guard pass while the live app falls back to an older build.
      const version = await readAsarPackageVersion(path.join(configDir, name));
      if (!version) continue;
      cachedVersions.push(version);
      if (!newestCachedAsar || compareObsidianVersions(version, newestCachedAsar.version) > 0) {
        newestCachedAsar = { name, path: path.join(configDir, name), version };
      }
    }
  } catch {
    // Config dir missing/unreadable - fall back to the bundled installer below.
  }

  let installerVersion: string | null = null;
  const candidates = options.bundledAsarCandidates ?? bundledAsarCandidates(obsidianApp);
  for (const candidate of candidates) {
    installerVersion = await readAsarPackageVersion(candidate);
    if (installerVersion) break;
  }

  const all = [...cachedVersions, installerVersion].filter((value): value is string =>
    Boolean(value),
  );
  const appVersion = all.length
    ? all.reduce((max, value) => (compareObsidianVersions(value, max) > 0 ? value : max))
    : null;

  return { appVersion, installerVersion, cachedVersions, configDir, newestCachedAsar };
}

/**
 * Materialize the app-code asar the guard predicts into the isolated sandbox so
 * a fresh instance boots exactly what we resolved. Remove any stale sandbox
 * asars first (a leftover from an older run could otherwise outrank the
 * prediction), then copy the resolved asar. Copy, not symlink: Obsidian rewrites
 * and deletes asars next to `obsidian.json`. A failed copy THROWS - succeeding
 * silently would let the guard pass while the instance boots something else.
 * With no cached asar the sandbox is left clean and the instance runs the
 * bundled installer build, which the guard still validates against minAppVersion.
 */
export async function reconcileSandboxAppAsar(
  userDataPath: string,
  newestCachedAsar: CachedAsar | null,
): Promise<string | null> {
  for (const name of await fs.readdir(userDataPath)) {
    if (!OBSIDIAN_ASAR_VERSION_RE.test(name)) continue;
    if (newestCachedAsar && name === newestCachedAsar.name) continue;
    await fs.rm(path.join(userDataPath, name), { force: true });
  }
  if (!newestCachedAsar) return null;

  const destination = path.join(userDataPath, newestCachedAsar.name);
  try {
    // Already seeded by a previous run (same name + size): skip the copy so
    // per-command CLI calls don't rewrite ~25MB under a running instance.
    const [source, existing] = await Promise.all([
      fs.stat(newestCachedAsar.path),
      fs.stat(destination),
    ]);
    if (source.size === existing.size) return newestCachedAsar.version;
  } catch {
    // Destination missing - fall through to the copy.
  }
  await fs.copyFile(newestCachedAsar.path, destination);
  return newestCachedAsar.version;
}

async function readPluginMinAppVersion(worktreePath: string): Promise<string> {
  const manifestPath = path.join(worktreePath, "manifest.json");
  const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const minAppVersion = isRecord(parsed) ? parsed.minAppVersion : undefined;
  if (typeof minAppVersion !== "string" || !/\d+\.\d+\.\d+/.test(minAppVersion)) {
    throw new Error(`manifest.json at ${manifestPath} has no usable minAppVersion.`);
  }
  return minAppVersion;
}

/**
 * Fail loudly when the running Obsidian app-code version is below the plugin's
 * `minAppVersion`, or cannot be determined at all. Filesystem-based, so it needs
 * no running instance. Returns the resolved versions for the caller to surface.
 */
export async function assertObsidianMeetsMinAppVersion(
  options: MinAppVersionOptions,
): Promise<MinAppVersionResult> {
  const minAppVersion = await readPluginMinAppVersion(options.worktreePath);
  const { appVersion, installerVersion, configDir } = await resolveObsidianAppVersion(options);

  if (!appVersion) {
    throw new Error(
      `Could not determine the running Obsidian app version (no obsidian-*.asar in ${configDir} ` +
        `and no bundled installer asar found). Refusing to run e2e against an unknown build that ` +
        `may be below the plugin's minAppVersion ${minAppVersion}.`,
    );
  }

  if (compareObsidianVersions(appVersion, minAppVersion) < 0) {
    throw new Error(
      `Obsidian app version ${appVersion} is BELOW the plugin's minAppVersion ${minAppVersion}` +
        `${installerVersion ? ` (installer shell ${installerVersion})` : ""}. Obsidian fell back ` +
        `to a build the plugin does not support, so any e2e "missing API" failure here is a FALSE ` +
        `signal, not a real bug. Update Obsidian to >= ${minAppVersion} (install it, or let it ` +
        `download an obsidian-*.asar into ${configDir}) before running e2e.`,
    );
  }

  return { appVersion, installerVersion, minAppVersion };
}
