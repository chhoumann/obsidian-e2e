import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createPluginHandle } from "../../src/core/plugin";
import { attachClientInternals, createRestoreManager } from "../../src/core/internals";
import type { ExecResult, ObsidianClient } from "../../src/core/types";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("plugin data restore", () => {
  test("restores the original plugin data after patching", async () => {
    const vaultRoot = await createVaultRoot();
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, '{\n\t"count": 1\n}\n', "utf8");

    const client = createFakeClient(vaultRoot);
    const plugin = client.plugin("quickadd");

    await plugin.data<{ count: number }>().patch((draft) => {
      draft.count += 1;
    });

    await expect(plugin.data<{ count: number }>().read()).resolves.toEqual({ count: 2 });

    await plugin.restoreData();

    await expect(plugin.data<{ count: number }>().read()).resolves.toEqual({ count: 1 });
  });

  test("removes plugin data files that were created from scratch", async () => {
    const vaultRoot = await createVaultRoot();
    const client = createFakeClient(vaultRoot);
    const plugin = client.plugin("quickadd");

    await plugin.data<{ enabled: boolean }>().write({ enabled: true });
    await plugin.restoreData();

    await expect(fs.access(await plugin.dataPath())).rejects.toThrow();
  });
});

async function createVaultRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-plugin-"));
  tempDirectories.push(directory);
  return directory;
}

function createFakeClient(vaultRoot: string) {
  const client: ObsidianClient = {
    bin: "obsidian",
    async exec(command): Promise<ExecResult> {
      return {
        argv: [],
        command,
        exitCode: 0,
        stderr: "",
        stdout: "",
      };
    },
    async execJson() {
      return {} as never;
    },
    async execText() {
      return "";
    },
    plugin(id: string) {
      return createPluginHandle(client, id);
    },
    async vaultPath() {
      return vaultRoot;
    },
    async verify() {},
    async waitFor(callback) {
      return (await callback()) as never;
    },
    vaultName: "dev",
  };

  attachClientInternals(
    client,
    createRestoreManager((filePath) => fs.readFile(filePath, "utf8")),
  );

  return client;
}
