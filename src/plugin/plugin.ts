import path from "node:path";

import { ObsidianCommandDispatchError, ObsidianCommandError } from "../core/errors";
import { getClientInternals } from "../core/internals";
import type {
  ExecOptions,
  ExecResult,
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

const MAX_TOGGLE_SENDS = 2;

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

  async function readEnabledFlag(execOptions: ExecOptions = {}): Promise<boolean | null> {
    const output = await client.execText(
      "plugin",
      { id },
      { ...execOptions, allowNonZeroExit: true },
    );
    const match = /^enabled\s+(true|false)\s*$/m.exec(output);
    return match ? match[1] === "true" : null;
  }

  async function setEnabled(
    enabled: boolean,
    options: PluginToggleOptions,
    execOptions: ExecOptions = {},
  ): Promise<void> {
    const command = enabled ? "plugin:enable" : "plugin:disable";

    for (let send = 1; ; send += 1) {
      let served: ExecResult | undefined;
      let sendError: unknown;

      try {
        // A nonzero exit means no reply was served, so it must take the resend path.
        served = await client.exec(
          command,
          { filter: options.filter, id },
          { ...execOptions, allowNonZeroExit: false },
        );
      } catch (error) {
        sendError = error;
      }

      const flag = await readEnabledFlag(execOptions);

      if (flag === enabled) {
        return;
      }

      if (served) {
        const state = flag === null ? "reported no enabled flag" : `its enabled flag is ${flag}`;
        throw new ObsidianCommandError(
          `Obsidian answered ${command} for plugin "${id}" with "${served.stdout.trim()}", but ${state}.`,
          served,
        );
      }

      // A second enable during Obsidian's `loadPlugin` read of main.js would load the plugin twice.
      const stillRunning =
        sendError instanceof ObsidianCommandDispatchError && sendError.reason === "still-pending";

      if (send === MAX_TOGGLE_SENDS || stillRunning) {
        throw sendError;
      }
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
      await setEnabled(false, options);
    },
    async enable(options: PluginToggleOptions = {}) {
      await setEnabled(true, options);
    },
    id,
    async isEnabled() {
      return (await readEnabledFlag()) === true;
    },
    async reload(options: PluginReloadOptions = {}) {
      const { readyOptions, waitUntilReady, ...execOptions } = options;

      // Obsidian refuses to reload a disabled plugin (an exit-0 "Error:" reply).
      // Enabling loads its main.js from disk, which is the reload asked for.
      if ((await readEnabledFlag(execOptions)) === false) {
        await setEnabled(true, {}, execOptions);
      } else {
        const result = await client.exec("plugin:reload", { id }, execOptions);

        if (result.stdout.startsWith("Error:")) {
          throw new ObsidianCommandError(
            `Obsidian answered plugin:reload for plugin "${id}" with "${result.stdout.trim()}".`,
            result,
          );
        }
      }

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

          if (options.commandId && !(await client.command(options.commandId).exists())) {
            return false;
          }

          if (options.predicate && !(await options.predicate(client))) {
            return false;
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
