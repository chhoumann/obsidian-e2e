import fs from "node:fs/promises";
import path from "node:path";

import { errorHasCode } from "../core/errors";

/**
 * Lowercase, collapse runs of unsupported characters to `-`, trim leading and
 * trailing `-`, cap at 80 characters. Falls back to `"worktree"` when nothing
 * usable remains. Used to derive a stable vault name from a worktree basename.
 */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "worktree"
  );
}

/**
 * Like {@link slugify} but without the length cap (the caller truncates) and
 * with a `"vault"` fallback. Used to sanitize a vault name into a filesystem-safe
 * instance-id component.
 */
export function safeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "vault"
  );
}

/** `lstat`-based existence check: detects broken symlinks, treats ENOENT as false. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return false;
    throw error;
  }
}

export interface WriteJsonOptions {
  mode?: number;
}

/**
 * Atomically write tab-indented JSON with a trailing newline via a `.tmp`
 * sibling plus `rename`. Refuses to write when the destination already exists as
 * a symlink or a non-regular file, so a co-located actor cannot redirect a write
 * (e.g. an `obsidian.json` under a `/tmp` profile root) through a planted link.
 */
export async function writeJson(
  filePath: string,
  value: unknown,
  options: WriteJsonOptions = {},
): Promise<void> {
  await assertRegularFileTarget(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const contents = `${JSON.stringify(value, null, "\t")}\n`;
  await fs.writeFile(
    tmpPath,
    contents,
    options.mode === undefined ? undefined : { mode: options.mode },
  );
  await fs.rename(tmpPath, filePath);
}

export async function writeJsonIfMissing(
  filePath: string,
  value: unknown,
  options: WriteJsonOptions = {},
): Promise<void> {
  if (await pathExists(filePath)) return;
  await writeJson(filePath, value, options);
}

async function assertRegularFileTarget(filePath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to write ${filePath}: it is a symlink or not a regular file.`);
  }
}

/** Single-quote a value for safe interpolation into a POSIX shell command. */
export function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export interface ShellExport {
  name: string;
  value: string;
}

/** Render `export NAME='value'` lines for `eval "$(... --print-env)"` consumers. */
export function toShellExports(exports: ShellExport[]): string {
  return exports.map(({ name, value }) => `export ${name}=${shellQuote(value)}`).join("\n");
}
