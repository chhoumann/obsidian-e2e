import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import process from "node:process";

import { errorHasCode } from "../core/errors";

export interface SecureDirOptions {
  /**
   * The uid every profile directory must be owned by. Injectable so the
   * foreign-owner branch is testable without a second account. `null` (the
   * resolution on a platform without `process.getuid`) skips the ownership check
   * rather than comparing against a missing uid.
   */
  currentUid?: number | null;
}

export function resolveCurrentUid(options: SecureDirOptions = {}): number | null {
  if ("currentUid" in options) return options.currentUid ?? null;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * Reject any directory we do not exclusively own. A directory we own with no
 * group/other access cannot have a foreign-planted child (only we can write into
 * it), so descending into it later is safe. We reject a loose (group/other-
 * accessible) dir rather than chmod-repairing it: an attacker who could write
 * while it was loose may already have planted a `home` symlink that a parent
 * chmod would not undo, and a later recursive mkdir / keychain link would follow.
 */
export function assertOwnedDir(dir: string, stat: Stats, currentUid: number | null): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to use ${dir}: it is a symlink or not a regular directory.`);
  }
  if (currentUid !== null && stat.uid !== currentUid) {
    throw new Error(`Refusing to use ${dir}: owned by uid ${stat.uid}, not ${currentUid}.`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to use ${dir}: it is group/other-accessible (mode ${(stat.mode & 0o777).toString(
        8,
      )}); remove it and retry.`,
    );
  }
}

/**
 * Create (when absent) and validate a private profile directory we own. The
 * profile root defaults under world-writable `/tmp`; if a co-located actor
 * pre-creates it (or symlinks it elsewhere) before our first run,
 * `fs.mkdir(..., { recursive })` is a no-op for ownership/mode and we would
 * otherwise write the keychain-bearing HOME (and `obsidian.json`) through their
 * directory. `lstat` first so we never mkdir through a pre-existing symlink,
 * then create only when absent, then assert ownership/mode. Callers must secure
 * a parent before its children so each child is created inside an already-0o700
 * tree the attacker cannot enter.
 */
export async function ensureSecureDir(
  dir: string,
  options: SecureDirOptions = {},
): Promise<string> {
  const currentUid = resolveCurrentUid(options);
  let stat: Stats;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    if (!errorHasCode(error, "ENOENT")) throw error;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(dir);
  }
  assertOwnedDir(dir, stat, currentUid);
  return dir;
}

/**
 * Validate an existing profile directory without creating or modifying it.
 * Teardown paths (stop/reap) read and remove inside the root, so they must
 * refuse a hijacked/symlinked root, but must not create one - a missing root
 * just means there is nothing to clean up. Returns `false` when the path is
 * absent, `true` when present and secure; throws when present and insecure.
 */
export async function assertSecureDirIfPresent(
  dir: string,
  options: SecureDirOptions = {},
): Promise<boolean> {
  const currentUid = resolveCurrentUid(options);
  let stat: Stats;
  try {
    stat = await fs.lstat(dir);
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return false;
    throw error;
  }
  assertOwnedDir(dir, stat, currentUid);
  return true;
}
