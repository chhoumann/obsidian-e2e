import fs from "node:fs/promises";
import path from "node:path";

import { createTempDir } from "./create-temp-dir";

export function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

/**
 * Build a spec-correct asar matching the real Pickle layout
 * (`[size pickle][header pickle][file data]`, header JSON 4-byte aligned inside
 * the header pickle). `extraJsonPad` widens the header JSON by exactly that many
 * bytes (the `_pad` key is always present, so each +1 shifts the length to the
 * next 4-byte residue), exercising the alignment padding a naive
 * `16 + jsonLength` reader gets wrong.
 */
export function buildAsar(version: string, extraJsonPad = 0): Buffer {
  const pkg = Buffer.from(JSON.stringify({ version }), "utf8");
  const files: Record<string, unknown> = {
    "package.json": { offset: "0", size: pkg.length },
    _pad: "x".repeat(extraJsonPad),
  };
  const json = Buffer.from(JSON.stringify({ files }), "utf8");
  const aligned = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const headerPayload = Buffer.concat([u32(json.length), aligned]);
  const headerPickle = Buffer.concat([u32(headerPayload.length), headerPayload]);
  const sizePickle = Buffer.concat([u32(4), u32(headerPickle.length)]);
  return Buffer.concat([sizePickle, headerPickle, pkg]);
}

/** Materialize a config dir holding real `obsidian-<version>.asar` archives. */
export async function makeConfigDir(
  tempDirectories: string[],
  versions: string[],
): Promise<string> {
  const dir = await createTempDir(tempDirectories, "obsidian-config-");
  await Promise.all(
    versions.map((version) =>
      fs.writeFile(path.join(dir, `obsidian-${version}.asar`), buildAsar(version)),
    ),
  );
  return dir;
}

/** Materialize a worktree with a `manifest.json` carrying `minAppVersion`. */
export async function makeWorktreeWithManifest(
  tempDirectories: string[],
  minAppVersion: string,
): Promise<string> {
  const dir = await createTempDir(tempDirectories, "worktree-");
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id: "obsidian-plugin", minAppVersion }),
  );
  return dir;
}
