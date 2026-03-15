import { test as base } from "vite-plus/test";

import { getClientInternals } from "../core/internals";
import type { ObsidianClient, VaultApi } from "../core/types";
import { createNoteDocument } from "../note/document";
import { createVaultApi } from "../vault/vault";
import { resolveFilesystemPath } from "../vault/paths";
import { createBaseFixtures, type BaseFixtureState } from "./base-fixtures";
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
      { _testContext }: Pick<BaseFixtureState, "_testContext">,
      use: (plugin: PluginFixtures["plugin"]) => Promise<void>,
    ) => {
      await use(
        await _testContext.plugin(options.pluginId, {
          filter: options.pluginFilter,
          seedData: options.seedPluginData,
        }),
      );
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
  vault: VaultApi,
  targetPath: string,
  value: VaultSeedEntry,
): Promise<void> {
  if (typeof value === "string") {
    await vault.write(targetPath, value, {
      waitForContent: true,
    });
    return;
  }

  if ("note" in value) {
    await vault.write(targetPath, createNoteDocument(value.note).raw, {
      waitForContent: true,
    });
    return;
  }

  await vault.write(targetPath, `${JSON.stringify(value.json, null, 2)}\n`, {
    waitForContent: true,
  });
}
