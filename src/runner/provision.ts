import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  pathExists,
  type ShellExport,
  slugify,
  toShellExports,
  writeJson,
  writeJsonIfMissing,
} from "./fs-utils";
import type {
  ProvisionOptions,
  ProvisionRawOptions,
  ProvisionResult,
  ResolvedRunnerConfig,
} from "./types";

/**
 * Default vault-root directory name, created inside the worktree. Worktree-
 * anchored (not cwd-anchored) so that `--worktree /other/checkout` places the
 * vault inside that checkout and parallel worktrees never collide on one root.
 */
export const DEFAULT_ROOT = ".obsidian-e2e-vaults";

/**
 * Resolve raw provisioning flags into concrete paths.
 *
 * The default vault root is anchored to the *worktree*, not `cwd`: the
 * provisioned vault must live inside the checkout whose plugin artifacts it
 * links, or parallel worktrees sharing a caller `cwd` would collide on one root
 * and break isolation. An explicit `--root` still resolves against `cwd`.
 */
export function resolveProvisionOptions(
  raw: ProvisionRawOptions,
  config: ResolvedRunnerConfig,
  cwd: string = process.cwd(),
): ProvisionOptions {
  const worktreePath = path.resolve(cwd, raw.worktree ?? ".");
  const vaultName = raw.vault ?? `${config.vaultPrefix}-${slugify(path.basename(worktreePath))}`;
  const rootPath = raw.root ? path.resolve(cwd, raw.root) : path.join(worktreePath, DEFAULT_ROOT);
  const vaultPath = path.resolve(rootPath, vaultName);
  const dataPath = raw.data ? path.resolve(cwd, raw.data) : undefined;

  return {
    dataPath,
    force: raw.force ?? false,
    json: raw.json ?? false,
    printEnv: raw.printEnv ?? false,
    rootPath,
    vaultName,
    vaultPath,
    worktreePath,
  };
}

/**
 * Provision a worktree-local Obsidian vault: lay down the `.obsidian` config,
 * symlink the plugin's build artifacts, and seed `data.json`. Pure filesystem -
 * it never launches Obsidian, disables Restricted Mode, or verifies the plugin
 * loads; that is the launcher's job.
 */
export async function provisionVault(
  options: ProvisionOptions,
  config: ResolvedRunnerConfig,
): Promise<ProvisionResult> {
  await assertRequiredPluginFiles(options.worktreePath, config);

  const obsidianPath = path.join(options.vaultPath, ".obsidian");
  const pluginPath = path.join(obsidianPath, "plugins", config.pluginId);

  await fs.mkdir(pluginPath, { recursive: true });
  await writeAppJson(path.join(obsidianPath, "app.json"));
  await writeJsonIfMissing(path.join(obsidianPath, "appearance.json"), {});
  await writeJsonIfMissing(path.join(obsidianPath, "core-plugins.json"), []);
  // community-plugins.json is written unconditionally: it keeps the plugin
  // enabled even if a prior provision or a manual edit dropped it. The vault is
  // disposable E2E state, never user data.
  await writeJson(path.join(obsidianPath, "community-plugins.json"), [config.pluginId]);
  await writeJsonIfMissing(
    path.join(obsidianPath, "workspace.json"),
    workspaceSkeleton(config.pluginId),
  );

  for (const fileName of config.pluginArtifacts) {
    await linkPluginFile(
      path.join(options.worktreePath, fileName),
      path.join(pluginPath, fileName),
      options.force,
    );
  }

  const pluginDataPath = path.join(pluginPath, "data.json");
  if (options.dataPath && !(await pathExists(pluginDataPath))) {
    // A `--data` seed on first provision is copied verbatim, not merged with the
    // default - the caller supplied the exact document they want loaded.
    await fs.copyFile(options.dataPath, pluginDataPath);
  } else {
    await writeJsonIfMissing(pluginDataPath, config.defaultData);
  }

  return {
    pluginPath,
    vaultName: options.vaultName,
    vaultPath: options.vaultPath,
    worktreePath: options.worktreePath,
  };
}

/**
 * Symlink a plugin artifact into the vault, reconciling any existing entry.
 * A correct symlink is a no-op; a symlink pointing elsewhere or a real file
 * throws (asking for `--force`) rather than clobbering; `force` unlinks and
 * relinks. Exported for direct testing.
 */
export async function linkPluginFile(
  sourcePath: string,
  destinationPath: string,
  force: boolean,
): Promise<void> {
  const existing = await pathExists(destinationPath);
  if (existing && force) {
    await fs.unlink(destinationPath);
  } else if (existing) {
    const stat = await fs.lstat(destinationPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `${destinationPath} exists and is not a symlink. Use --force after reviewing it.`,
      );
    }

    const currentTarget = await fs.readlink(destinationPath);
    if (path.resolve(path.dirname(destinationPath), currentTarget) === sourcePath) {
      return;
    }

    throw new Error(`${destinationPath} points at ${currentTarget}. Use --force to relink it.`);
  }

  await fs.symlink(sourcePath, destinationPath);
}

/**
 * Render the shell exports for `eval "$(... --print-env)"`. Emits the canonical
 * `OBSIDIAN_E2E_VAULT[_PATH]` names, plus legacy `<envPrefix>_E2E_VAULT[_PATH]`
 * aliases while a consumer harness is still migrating off its old names.
 */
export function provisionShellExports(
  result: ProvisionResult,
  config: ResolvedRunnerConfig,
): string {
  const exports: ShellExport[] = [
    { name: "OBSIDIAN_E2E_VAULT", value: result.vaultName },
    { name: "OBSIDIAN_E2E_VAULT_PATH", value: result.vaultPath },
  ];
  if (config.envPrefix) {
    exports.push(
      { name: `${config.envPrefix}_E2E_VAULT`, value: result.vaultName },
      { name: `${config.envPrefix}_E2E_VAULT_PATH`, value: result.vaultPath },
    );
  }
  return toShellExports(exports);
}

/**
 * Vault `app.json` keys the harness enforces, overriding both Obsidian's
 * defaults and any drifted vault state:
 * - `settingsPopoutWindow: false` - Obsidian 1.13+ defaults to opening
 *   Settings in a separate popout window, outside the main window the harness
 *   drives and captures.
 * - `spellcheck: false` - the default (true) underlines typed test content
 *   using OS dictionaries and language settings, adding per-machine variance
 *   to screenshots and failure artifacts.
 * - `trashOption: "local"` - the default ("system") sends UI-driven deletes
 *   to the OS trash, leaking disposable test state outside the vault.
 */
export const ENFORCED_APP_CONFIG = {
  settingsPopoutWindow: false,
  spellcheck: false,
  trashOption: "local",
} as const;

/**
 * Seed `app.json`, forcing {@link ENFORCED_APP_CONFIG} while preserving every
 * other existing key. Re-applied on every provision (not write-if-missing) so
 * vaults provisioned before these Obsidian defaults existed are corrected on
 * their next run.
 */
async function writeAppJson(appJsonPath: string): Promise<void> {
  let existing: Record<string, unknown> = {};
  if (await pathExists(appJsonPath)) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(appJsonPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable app.json in a disposable E2E vault: reseed it.
    }
  }
  await writeJson(appJsonPath, { ...existing, ...ENFORCED_APP_CONFIG });
}

/**
 * Throw with a "build first" hint when any configured plugin artifact is
 * missing from the worktree. Shared with the android runner, which pushes the
 * same artifacts to the device instead of symlinking them.
 */
export async function assertRequiredPluginFiles(
  worktreePath: string,
  config: ResolvedRunnerConfig,
): Promise<void> {
  const missing: string[] = [];
  for (const fileName of config.pluginArtifacts) {
    if (!(await pathExists(path.join(worktreePath, fileName)))) missing.push(fileName);
  }

  if (missing.length > 0) {
    throw new Error(
      `Cannot provision ${config.pluginId} in ${worktreePath}; missing ${missing.join(", ")}. ` +
        `Run ${config.buildCommand} in that worktree before provisioning.`,
    );
  }
}

/** Minimal three-pane workspace with split ids namespaced from the plugin id. */
function workspaceSkeleton(pluginId: string) {
  const base = `${pluginId}-e2e`;
  return {
    main: { id: base, type: "split", children: [] },
    left: { id: `${base}-left`, type: "split", children: [] },
    right: { id: `${base}-right`, type: "split", children: [] },
  };
}
