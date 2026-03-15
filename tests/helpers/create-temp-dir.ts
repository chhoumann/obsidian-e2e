import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createTempDir(prefix: string): Promise<string>;
export async function createTempDir(tempDirectories: string[], prefix: string): Promise<string>;
export async function createTempDir(
  prefixOrTempDirectories: string | string[],
  maybePrefix?: string,
): Promise<string> {
  const [tempDirectories, prefix] =
    typeof prefixOrTempDirectories === "string"
      ? [undefined, prefixOrTempDirectories]
      : [prefixOrTempDirectories, maybePrefix];

  if (!prefix) {
    throw new Error("createTempDir requires a prefix.");
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories?.push(directory);
  return directory;
}

export async function cleanupTempDirectories(tempDirectories: string[]): Promise<void> {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
}
