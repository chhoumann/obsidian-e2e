import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createObsidianClient } from "../../src/core/client";
import { waitForValue } from "../../src/core/wait";
import { createStubObsidianClient } from "../helpers/stub-obsidian-client";
import type { CommandTransport } from "../../src/core/types";

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

describe("plugin readiness helpers", () => {
  test("reload can wait until a plugin is loaded and its command is registered again", async () => {
    let readyAttempts = 0;
    let commandAttempts = 0;

    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[0] === "--help") {
        return createResult(request.bin, request.argv, "usage\n");
      }

      const [, command, ...rest] = request.argv;
      const args = Object.fromEntries(
        rest
          .filter((entry) => entry.includes("="))
          .map((entry) => {
            const [key, ...value] = entry.split("=");
            return [key, value.join("=")];
          }),
      );

      if (command === "vault" && args.info === "path") {
        return createResult(request.bin, request.argv, "/tmp/vault\n");
      }

      if (command === "eval") {
        readyAttempts += 1;
        return createResult(request.bin, request.argv, `=> ${readyAttempts > 1}\n`);
      }

      if (command === "plugin:reload") {
        return createResult(request.bin, request.argv, "");
      }

      if (command === "commands") {
        commandAttempts += 1;

        return createResult(
          request.bin,
          request.argv,
          commandAttempts > 1 ? "quickadd:list\tList choices\n" : "",
        );
      }

      throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
    });

    const client = createObsidianClient({
      intervalMs: 1,
      timeoutMs: 25,
      transport,
      vault: "dev",
    });

    await expect(
      client.plugin("quickadd").reload({
        readyOptions: {
          commandId: "quickadd:list",
        },
        waitUntilReady: true,
      }),
    ).resolves.toBeUndefined();

    expect(readyAttempts).toBeGreaterThan(1);
    expect(commandAttempts).toBeGreaterThan(1);
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["vault=dev", "plugin:reload", "id=quickadd"],
      }),
    );
  });

  test("waitForData tolerates missing and invalid data until the predicate matches", async () => {
    const vaultRoot = await createVaultRoot();
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    const client = createStubObsidianClient({
      vaultRoot,
      waitFor: (callback, options) => waitForValue(callback, options),
    });
    const plugin = client.plugin("quickadd");

    setTimeout(async () => {
      await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
      await fs.writeFile(pluginDataPath, '{"count":', "utf8");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await fs.writeFile(pluginDataPath, '{\n  "count": 2\n}\n', "utf8");
    }, 5);

    await expect(
      plugin.waitForData<{ count: number }>((data) => data.count === 2, {
        intervalMs: 1,
        timeoutMs: 50,
      }),
    ).resolves.toEqual({ count: 2 });
  });
});

async function createVaultRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-plugin-"));
  tempDirectories.push(directory);
  return directory;
}

function createFakeClient(vaultRoot: string) {
  return createStubObsidianClient({
    readFileForRestore: (filePath) => fs.readFile(filePath, "utf8"),
    vaultRoot,
  });
}

function createResult(command: string, argv: string[], stdout: string) {
  return {
    argv,
    command,
    exitCode: 0,
    stderr: "",
    stdout,
  };
}
