import path from "node:path";
import { posix as pathPosix } from "node:path";

import type { ObsidianClient } from "../core/types";

export function normalizeScope(scope?: string): string {
  if (!scope || scope === ".") {
    return "";
  }

  return scope.replace(/^\/+|\/+$/g, "");
}

export function resolveVaultPath(scopeRoot: string, targetPath: string): string {
  if (!targetPath || targetPath === ".") {
    return scopeRoot;
  }

  return scopeRoot ? pathPosix.join(scopeRoot, targetPath) : pathPosix.normalize(targetPath);
}

export async function resolveFilesystemPath(
  obsidian: ObsidianClient,
  scopeRoot: string,
  targetPath: string,
): Promise<string> {
  const vaultPath = await obsidian.vaultPath();
  const scopedPath = resolveVaultPath(scopeRoot, targetPath);
  const relativePath = scopedPath.split("/").filter(Boolean);
  const resolvedPath = path.resolve(vaultPath, ...relativePath);
  const normalizedVaultPath = path.resolve(vaultPath);

  if (
    resolvedPath !== normalizedVaultPath &&
    !resolvedPath.startsWith(`${normalizedVaultPath}${path.sep}`)
  ) {
    throw new Error(`Resolved path escapes the vault root: ${targetPath}`);
  }

  return resolvedPath;
}
