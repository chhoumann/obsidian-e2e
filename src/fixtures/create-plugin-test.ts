import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { test as base } from "vite-plus/test";
import type { TestContext } from "vite-plus/test";

import { getClientInternals } from "../core/internals";
import type { ObsidianClient } from "../core/types";
import { createVaultApi } from "../vault/vault";
import { createBaseFixtures } from "./base-fixtures";
import { registerPluginFailureArtifacts } from "./failure-artifacts";
import type {
  CreatePluginTestOptions,
  PluginFixtures,
  PluginTest,
  VaultSeed,
  VaultSeedEntry,
} from "./types";

export function createPluginTest(options: CreatePluginTestOptions): PluginTest {
  return base.extend<PluginFixtures>({
    ...createBaseFixtures(options, {
      async createVault(obsidian) {
        if (options.seedVault) {
          await applyVaultSeed(obsidian, options.seedVault);
        }

        return createVaultApi({ obsidian });
      },
    }),
    plugin: async (
      {
        obsidian,
        onTestFailed,
        task,
      }: Pick<PluginFixtures & TestContext, "obsidian" | "onTestFailed" | "task">,
      use,
    ) => {
      const plugin = obsidian.plugin(options.pluginId);
      const wasEnabled = await plugin.isEnabled();

      if (!wasEnabled) {
        await plugin.enable({ filter: options.pluginFilter });
      }

      if (options.seedPluginData !== undefined) {
        await plugin.data().write(options.seedPluginData);
      }

      registerPluginFailureArtifacts({ onTestFailed, task }, plugin, options);

      try {
        await use(plugin);
      } finally {
        if (!wasEnabled) {
          await plugin.disable({ filter: options.pluginFilter });
        }
      }
    },
  });
}

async function applyVaultSeed(obsidian: ObsidianClient, seedVault: VaultSeed): Promise<void> {
  const vaultRoot = await obsidian.vaultPath();

  for (const [targetPath, value] of Object.entries(seedVault)) {
    const resolvedPath = path.resolve(vaultRoot, ...targetPath.split("/").filter(Boolean));
    const normalizedVaultRoot = path.resolve(vaultRoot);

    if (
      resolvedPath !== normalizedVaultRoot &&
      !resolvedPath.startsWith(`${normalizedVaultRoot}${path.sep}`)
    ) {
      throw new Error(`Seed path escapes the vault root: ${targetPath}`);
    }

    await getClientInternals(obsidian).snapshotFileOnce(resolvedPath);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeSeedValue(resolvedPath, value);
  }
}

async function writeSeedValue(resolvedPath: string, value: VaultSeedEntry): Promise<void> {
  if (typeof value === "string") {
    await writeFile(resolvedPath, value, "utf8");
    return;
  }

  await writeFile(resolvedPath, `${JSON.stringify(value.json, null, 2)}\n`, "utf8");
}
