import { test as base } from "vite-plus/test";
import type { TestContext } from "vite-plus/test";

import { getClientInternals } from "../core/internals";
import type { ObsidianClient } from "../core/types";
import { createVaultApi } from "../vault/vault";
import { resolveFilesystemPath } from "../vault/paths";
import { createBaseFixtures, type BaseFixtureState } from "./base-fixtures";
import { registerFailureArtifacts } from "./failure-artifacts";
import type {
  CreatePluginTestOptions,
  PluginFixtures,
  PluginTest,
  VaultSeed,
  VaultSeedEntry,
} from "./types";

export function createPluginTest(options: CreatePluginTestOptions): PluginTest {
  const fixtures = {
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
      use: (plugin: PluginFixtures["plugin"]) => Promise<void>,
    ) => {
      const plugin = obsidian.plugin(options.pluginId);
      const wasEnabled = await plugin.isEnabled();

      if (!wasEnabled) {
        await plugin.enable({ filter: options.pluginFilter });
      }

      if (options.seedPluginData !== undefined) {
        await plugin.data().write(options.seedPluginData);
      }

      registerFailureArtifacts({ onTestFailed, task }, obsidian, options, plugin);

      try {
        await use(plugin);
      } finally {
        if (!wasEnabled) {
          await plugin.disable({ filter: options.pluginFilter });
        }
      }
    },
  };

  return base.extend<PluginFixtures & BaseFixtureState>(fixtures as never) as PluginTest;
}

async function applyVaultSeed(obsidian: ObsidianClient, seedVault: VaultSeed): Promise<void> {
  const vault = createVaultApi({ obsidian });

  for (const [targetPath, value] of Object.entries(seedVault)) {
    const resolvedPath = await resolveFilesystemPath(obsidian, "", targetPath);
    await getClientInternals(obsidian).snapshotFileOnce(resolvedPath);
    await writeSeedValue(vault, targetPath, value);
  }
}

async function writeSeedValue(
  vault: ReturnType<typeof createVaultApi>,
  targetPath: string,
  value: VaultSeedEntry,
): Promise<void> {
  if (typeof value === "string") {
    await vault.write(targetPath, value, {
      waitForContent: true,
    });
    return;
  }

  await vault.write(targetPath, `${JSON.stringify(value.json, null, 2)}\n`, {
    waitForContent: true,
  });
}
