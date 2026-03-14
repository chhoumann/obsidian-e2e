import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createObsidianClient } from "../../src/core/client";
import { sleep, waitForValue } from "../../src/core/wait";
import { createStubObsidianClient } from "../helpers/stub-obsidian-client";
import { createExecResult } from "../helpers/create-exec-result";
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
        return createExecResult(request.bin, request.argv, "usage\n");
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
        return createExecResult(request.bin, request.argv, "/tmp/vault\n");
      }

      if (command === "eval") {
        readyAttempts += 1;
        return createExecResult(
          request.bin,
          request.argv,
          `${JSON.stringify({ ok: true, value: readyAttempts > 1 })}\n`,
        );
      }

      if (command === "plugin:reload") {
        return createExecResult(request.bin, request.argv, "");
      }

      if (command === "commands") {
        commandAttempts += 1;

        return createExecResult(
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
      await sleep(5);
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

describe("plugin data ergonomics", () => {
  test("updateDataAndReload reloads enabled plugins and waits by default", async () => {
    const vaultRoot = await createVaultRoot();
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, '{\n  "count": 1\n}\n', "utf8");

    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[0] === "--help") {
        return createExecResult(request.bin, request.argv, "usage\n");
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
        return createExecResult(request.bin, request.argv, `${vaultRoot}\n`);
      }

      if (command === "plugin") {
        return createExecResult(request.bin, request.argv, "enabled\ttrue\n");
      }

      if (command === "plugin:reload") {
        return createExecResult(request.bin, request.argv, "");
      }

      if (command === "eval") {
        return createExecResult(
          request.bin,
          request.argv,
          `${JSON.stringify({ ok: true, value: true })}\n`,
        );
      }

      throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });
    const plugin = client.plugin("quickadd");

    await expect(
      plugin.updateDataAndReload<{ count: number }>((draft) => {
        draft.count += 1;
      }),
    ).resolves.toEqual({ count: 2 });
    await expect(plugin.data<{ count: number }>().read()).resolves.toEqual({ count: 2 });

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["vault=dev", "plugin:reload", "id=quickadd"],
      }),
    );
    expect(transport.mock.calls.some((call) => call[0].argv[1] === "eval")).toBe(true);
  });

  test("updateDataAndReload patches data without reloading disabled plugins", async () => {
    const vaultRoot = await createVaultRoot();
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, '{\n  "enabled": false\n}\n', "utf8");

    const client = createFakeClient(vaultRoot);
    const plugin = client.plugin("quickadd");

    await expect(
      plugin.updateDataAndReload<{ enabled: boolean }>((draft) => {
        draft.enabled = true;
      }),
    ).resolves.toEqual({ enabled: true });
    await expect(plugin.data<{ enabled: boolean }>().read()).resolves.toEqual({ enabled: true });
  });

  test("withPatchedData restores original data even when the callback fails", async () => {
    const vaultRoot = await createVaultRoot();
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, '{\n  "count": 1\n}\n', "utf8");

    const client = createFakeClient(vaultRoot);
    const plugin = client.plugin("quickadd");

    await expect(
      plugin.withPatchedData<{ count: number }>(
        (draft) => {
          draft.count = 9;
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    await expect(plugin.data<{ count: number }>().read()).resolves.toEqual({ count: 1 });
  });

  test("withPatchedData reloads enabled plugins when patching and restoring", async () => {
    const vaultRoot = await createVaultRoot();
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, '{\n  "count": 1\n}\n', "utf8");

    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[0] === "--help") {
        return createExecResult(request.bin, request.argv, "usage\n");
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
        return createExecResult(request.bin, request.argv, `${vaultRoot}\n`);
      }

      if (command === "plugin") {
        return createExecResult(request.bin, request.argv, "enabled\ttrue\n");
      }

      if (command === "plugin:reload") {
        return createExecResult(request.bin, request.argv, "");
      }

      if (command === "eval") {
        return createExecResult(
          request.bin,
          request.argv,
          `${JSON.stringify({ ok: true, value: true })}\n`,
        );
      }

      throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });
    const plugin = client.plugin("quickadd");

    await expect(
      plugin.withPatchedData<{ count: number }, number>(
        (draft) => {
          draft.count = 3;
        },
        async () => {
          await expect(plugin.data<{ count: number }>().read()).resolves.toEqual({ count: 3 });
          return 3;
        },
      ),
    ).resolves.toBe(3);

    await expect(plugin.data<{ count: number }>().read()).resolves.toEqual({ count: 1 });

    const reloadCalls = transport.mock.calls.filter((call) => call[0].argv[1] === "plugin:reload");
    expect(reloadCalls).toHaveLength(2);
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
