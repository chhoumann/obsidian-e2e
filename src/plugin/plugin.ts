import path from "node:path";

import { getClientInternals } from "../core/internals";
import type {
  JsonFile,
  ObsidianClient,
  PluginDataPredicate,
  PluginHandle,
  PluginReloadOptions,
  PluginToggleOptions,
  PluginWaitForDataOptions,
  PluginWaitUntilReadyOptions,
} from "../core/types";
import { createJsonFile } from "../vault/json-file";

export function createPluginHandle(client: ObsidianClient, id: string): PluginHandle {
  async function resolveDataPath() {
    const vaultPath = await client.vaultPath();
    return path.join(vaultPath, ".obsidian", "plugins", id, "data.json");
  }

  async function isLoadedInApp(): Promise<boolean> {
    try {
      return await client.dev.eval<boolean>(`(() => {
        const plugins = app?.plugins;
        return Boolean(
          plugins?.enabledPlugins?.has?.(${JSON.stringify(id)}) &&
          plugins?.plugins?.[${JSON.stringify(id)}],
        );
      })()`);
    } catch {
      return false;
    }
  }

  return {
    data<T = unknown>(): JsonFile<T> {
      return {
        async patch(updater) {
          const dataPath = await resolveDataPath();
          return createJsonFile<T>(dataPath, () =>
            getClientInternals(client).snapshotFileOnce(dataPath),
          ).patch(updater);
        },
        async read() {
          const dataPath = await resolveDataPath();
          return createJsonFile<T>(dataPath).read();
        },
        async write(value) {
          const dataPath = await resolveDataPath();
          await createJsonFile<T>(dataPath, () =>
            getClientInternals(client).snapshotFileOnce(dataPath),
          ).write(value);
        },
      };
    },
    async dataPath() {
      return resolveDataPath();
    },
    async disable(options: PluginToggleOptions = {}) {
      await client.exec("plugin:disable", {
        filter: options.filter,
        id,
      });
    },
    async enable(options: PluginToggleOptions = {}) {
      await client.exec("plugin:enable", {
        filter: options.filter,
        id,
      });
    },
    id,
    async isEnabled() {
      const output = await client.execText("plugin", { id }, { allowNonZeroExit: true });
      return /enabled\s+true/i.test(output);
    },
    async reload(options: PluginReloadOptions = {}) {
      const { readyOptions, waitUntilReady, ...execOptions } = options;

      await client.exec("plugin:reload", { id }, execOptions);

      if (waitUntilReady) {
        await this.waitUntilReady(readyOptions);
      }
    },
    async restoreData() {
      await getClientInternals(client).restoreFile(await resolveDataPath());
    },
    async waitForData<T = unknown>(
      predicate: PluginDataPredicate<T>,
      options: PluginWaitForDataOptions = {},
    ) {
      return client.waitFor(async () => {
        try {
          const data = await this.data<T>().read();
          return (await predicate(data)) ? data : false;
        } catch {
          return false;
        }
      }, options);
    },
    async waitUntilReady(options: PluginWaitUntilReadyOptions = {}) {
      await client.waitFor(
        async () => {
          if (!(await isLoadedInApp())) {
            return false;
          }

          if (options.commandId) {
            return (await client.command(options.commandId).exists()) ? true : false;
          }

          return true;
        },
        {
          message:
            options.message ??
            (options.commandId
              ? `plugin "${id}" to be ready with command "${options.commandId}"`
              : `plugin "${id}" to be ready`),
          ...options,
        },
      );
    },
  };
}
