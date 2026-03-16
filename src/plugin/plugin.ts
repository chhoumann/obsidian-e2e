import path from "node:path";

import { getClientInternals } from "../core/internals";
import type {
  JsonFile,
  JsonFileUpdater,
  ObsidianClient,
  PluginDataPredicate,
  PluginHandle,
  PluginReloadOptions,
  PluginToggleOptions,
  PluginUpdateDataOptions,
  PluginWithPatchedDataOptions,
  PluginWaitForDataOptions,
  PluginWaitUntilReadyOptions,
} from "../core/types";
import { runEvalJson } from "../dev/eval-json";
import { createJsonFile } from "../vault/json-file";

export function createPluginHandle(client: ObsidianClient, id: string): PluginHandle {
  async function resolveDataPath() {
    const vaultPath = await client.vaultPath();
    return path.join(vaultPath, ".obsidian", "plugins", id, "data.json");
  }

  async function isLoadedInApp(): Promise<boolean> {
    try {
      return await runEvalJson<boolean>(client.dev, buildPluginLoadedCode(id));
    } catch {
      return false;
    }
  }

  function withDefaultReadyReloadOptions(options: PluginReloadOptions = {}): PluginReloadOptions {
    return {
      ...options,
      waitUntilReady: options.waitUntilReady ?? true,
    };
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
    async updateDataAndReload<T = unknown>(
      updater: JsonFileUpdater<T>,
      options: PluginUpdateDataOptions<T> = {},
    ): Promise<T> {
      const nextData = await this.data<T>().patch(updater);

      if (await this.isEnabled()) {
        await this.reload(withDefaultReadyReloadOptions(options));
      }

      return nextData;
    },
    async withPatchedData<T = unknown, TResult = void>(
      updater: JsonFileUpdater<T>,
      run: (plugin: PluginHandle) => Promise<TResult> | TResult,
      options: PluginWithPatchedDataOptions<T> = {},
    ): Promise<TResult> {
      const pluginWasEnabled = await this.isEnabled();
      const reloadOptions = withDefaultReadyReloadOptions(options);
      let hasPatchedData = false;
      let runResult: TResult | undefined;
      let runError: unknown;
      let restoreError: unknown;

      try {
        await this.data<T>().patch(updater);
        hasPatchedData = true;

        if (pluginWasEnabled) {
          await this.reload(reloadOptions);
        }

        runResult = await run(this);
      } catch (error) {
        runError = error;
      }

      if (hasPatchedData) {
        try {
          await this.restoreData();

          if (pluginWasEnabled) {
            await this.reload(reloadOptions);
          }
        } catch (error) {
          restoreError = error;
        }
      }

      if (runError && restoreError) {
        throw new AggregateError(
          [runError, restoreError],
          `Plugin "${id}" patch execution and restore both failed.`,
        );
      }

      if (runError) {
        throw runError;
      }

      if (restoreError) {
        throw restoreError;
      }

      return runResult as TResult;
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
            return await client.command(options.commandId).exists();
          }

          return true;
        },
        {
          ...options,
          message:
            options.message ??
            (options.commandId
              ? `plugin "${id}" to be ready with command "${options.commandId}"`
              : `plugin "${id}" to be ready`),
        },
      );
    },
  };
}

function buildPluginLoadedCode(id: string): string {
  return [
    "(()=>{",
    "const __obsidianE2EPlugins=app?.plugins;",
    `return Boolean(__obsidianE2EPlugins?.enabledPlugins?.has?.(${JSON.stringify(id)})&&__obsidianE2EPlugins?.plugins?.[${JSON.stringify(id)}]);`,
    "})()",
  ].join("");
}
