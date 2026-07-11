import { existsSync, promises as fs, readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { createTestContext, withVaultSandbox } from "../../src";
import { createExecResult, frameEvalPayload } from "../helpers/create-exec-result";
import type { CommandTransport } from "../../src/core/types";
import {
  cleanupTempDirectories,
  createTempDir as createTrackedTempDir,
} from "../helpers/create-temp-dir";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

describe("test context", () => {
  test("tracks plugin sessions and sandbox cleanup", async () => {
    const vaultRoot = await createVaultRoot("obsidian-e2e-context-");
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, `${JSON.stringify({ count: 1 }, null, 2)}\n`, "utf8");
    const transportCalls: string[][] = [];

    const context = await createTestContext({
      testName: "Context",
      transport: createTransport(vaultRoot, transportCalls),
      vault: "dev",
    });

    const plugin = await context.plugin("quickadd", {
      filter: "community",
      seedData: { count: 2 },
    });

    await context.sandbox.write("inside.md", "inside");
    await expect(plugin.data<{ count: number }>().read()).resolves.toEqual({ count: 2 });

    const sandboxRoot = context.sandbox.root;
    await context.cleanup();

    await expect(fs.readFile(pluginDataPath, "utf8")).resolves.toContain('"count": 1');
    await expect(fs.access(path.join(vaultRoot, sandboxRoot))).rejects.toThrow();
    expect(transportCalls).toContainEqual([
      "vault=dev",
      "plugin:enable",
      "filter=community",
      "id=quickadd",
    ]);
    expect(transportCalls).toContainEqual([
      "vault=dev",
      "plugin:disable",
      "filter=community",
      "id=quickadd",
    ]);
  });

  test("withVaultSandbox disposes automatically", async () => {
    const vaultRoot = await createVaultRoot("obsidian-e2e-context-auto-");

    let sandboxRoot = "";
    await withVaultSandbox(
      {
        testName: "Auto",
        transport: createTransport(vaultRoot, []),
        vault: "dev",
      },
      async (context) => {
        sandboxRoot = context.sandbox.root;
        await context.sandbox.write("auto.md", "auto");
      },
    );

    await expect(fs.access(path.join(vaultRoot, sandboxRoot))).rejects.toThrow();
  });

  test("cleanup continues after plugin disable failures", async () => {
    const vaultRoot = await createVaultRoot("obsidian-e2e-context-disable-failure-");
    const transportCalls: string[][] = [];

    const context = await createTestContext({
      testName: "Context cleanup failure",
      transport: createTransport(vaultRoot, transportCalls, {
        failDisable: true,
      }),
      vault: "dev",
    });

    await context.plugin("quickadd", {
      filter: "community",
    });
    await context.sandbox.write("inside.md", "inside");

    const sandboxRoot = context.sandbox.root;
    await expect(context.cleanup()).rejects.toThrow("disable failed");
    await expect(fs.access(path.join(vaultRoot, sandboxRoot))).rejects.toThrow();
  });
  test("cleanup deletes the sandbox before clearing the marker and releasing the lock", async () => {
    // https://github.com/chhoumann/obsidian-e2e/issues/19: a waiting run must
    // never acquire the vault while the previous run is still deleting content.
    const vaultRoot = await createVaultRoot("obsidian-e2e-context-teardown-order-");
    const lockRoot = await createVaultRoot("obsidian-e2e-context-lock-");
    let sandboxPath = "";
    let sandboxExistedAtMarkerClear: boolean | undefined;
    let lockHeldAtMarkerClear: boolean | undefined;

    const context = await createTestContext({
      sharedVaultLock: { lockRoot },
      testName: "Teardown order",
      transport: createTransport(vaultRoot, [], {
        onEval(code) {
          if (code.includes("delete window.__obsidianE2ELock")) {
            sandboxExistedAtMarkerClear = existsSync(sandboxPath);
            lockHeldAtMarkerClear = readdirSync(lockRoot).length === 1;
          }
        },
      }),
      vault: "dev",
    });

    sandboxPath = path.join(vaultRoot, context.sandbox.root);
    await context.sandbox.write("inside.md", "inside");
    await context.cleanup();

    // Sandbox content was already gone and the lock was still held when the
    // in-app marker was cleared; the lock is released last.
    expect(sandboxExistedAtMarkerClear).toBe(false);
    expect(lockHeldAtMarkerClear).toBe(true);
    expect(readdirSync(lockRoot)).toHaveLength(0);
  });

  test("cleanup surfaces marker-clear failures and still releases the lock", async () => {
    const vaultRoot = await createVaultRoot("obsidian-e2e-context-marker-failure-");
    const lockRoot = await createVaultRoot("obsidian-e2e-context-lock-failure-");

    const context = await createTestContext({
      sharedVaultLock: { lockRoot },
      testName: "Marker failure",
      transport: createTransport(vaultRoot, [], { failMarkerClear: true }),
      vault: "dev",
    });

    await context.sandbox.write("inside.md", "inside");
    const sandboxRoot = context.sandbox.root;

    await expect(context.cleanup()).rejects.toThrow("marker clear failed");
    await expect(fs.access(path.join(vaultRoot, sandboxRoot))).rejects.toThrow();
    expect(readdirSync(lockRoot)).toHaveLength(0);
  });

  test("cleanup without a shared vault lock never touches the in-app marker", async () => {
    const vaultRoot = await createVaultRoot("obsidian-e2e-context-no-lock-");
    const evalCodes: string[] = [];

    const context = await createTestContext({
      testName: "No lock",
      transport: createTransport(vaultRoot, [], {
        onEval(code) {
          evalCodes.push(code);
        },
      }),
      vault: "dev",
    });

    await context.cleanup();

    expect(evalCodes.some((code) => code.includes("delete window.__obsidianE2ELock"))).toBe(false);
  });
});

async function createVaultRoot(prefix: string): Promise<string> {
  return createTrackedTempDir(tempDirectories, prefix);
}

function createTransport(
  vaultRoot: string,
  transportCalls: string[][],
  options: {
    failDisable?: boolean;
    failMarkerClear?: boolean;
    onEval?: (code: string) => void;
  } = {},
): CommandTransport {
  let enabled = false;

  return async (request) => {
    transportCalls.push([...request.argv]);

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
      return createExecResult(request.bin, request.argv, `enabled\t${enabled}\n`);
    }

    if (command === "plugin:enable") {
      enabled = true;
      return createExecResult(request.bin, request.argv, "");
    }

    if (command === "plugin:disable") {
      if (options.failDisable) {
        throw new Error("disable failed");
      }

      enabled = false;
      return createExecResult(request.bin, request.argv, "");
    }

    if (command === "eval") {
      const code = String(args.code ?? "");
      options.onEval?.(code);

      if (options.failMarkerClear && code.includes("delete window.__obsidianE2ELock")) {
        throw new Error("marker clear failed");
      }

      return createExecResult(
        request.bin,
        request.argv,
        `${frameEvalPayload(String(args.code ?? ""), '{"ok":true,"value":true}')}\n`,
      );
    }

    throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
  };
}
