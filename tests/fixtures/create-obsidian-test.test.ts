import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, expect } from "vite-plus/test";

import { createObsidianTest } from "../../src/vitest";
import { createExecResult } from "../helpers/create-exec-result";
import type { CommandTransport } from "../../src/core/types";

let sandboxRootPath = "";
const sharedLockRoot = path.join(os.tmpdir(), `obsidian-e2e-shared-lock-${process.pid}`);
let vaultRoot = "";
const evalCalls: string[] = [];

const fixtureTest = createObsidianTest({
  sharedVaultLock: {
    heartbeatMs: 10_000,
    lockRoot: sharedLockRoot,
  },
  transport: createTransport(),
  vault: "dev",
});

beforeAll(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-fixtures-"));

  await fs.mkdir(path.join(vaultRoot, ".obsidian", "plugins", "quickadd"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json"),
    `${JSON.stringify({ count: 1 }, null, 2)}\n`,
    "utf8",
  );
});

afterAll(async () => {
  await expect(fs.access(path.join(vaultRoot, sandboxRootPath))).rejects.toThrow();
  await expect(
    fs.readFile(path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json"), "utf8"),
  ).resolves.toContain('"count": 1');

  await fs.rm(sharedLockRoot, { force: true, recursive: true });
  await fs.rm(vaultRoot, { force: true, recursive: true });
});

fixtureTest(
  "injects fixtures and restores plugin data and sandbox state",
  async ({ obsidian, sandbox, vault }) => {
    sandboxRootPath = sandbox.root;

    await vault.write("outside.md", "outside");
    await sandbox.write("inside.md", "inside");
    await obsidian
      .plugin("quickadd")
      .data<{ count: number }>()
      .patch((draft) => {
        draft.count = 2;
      });

    await expect(vault.read("outside.md")).resolves.toBe("outside");
    await expect(sandbox.read("inside.md")).resolves.toBe("inside");
    await expect(fs.readdir(sharedLockRoot)).resolves.toHaveLength(1);
    expect(evalCalls.some((code) => code.includes("__obsidianE2ELock"))).toBe(true);
    await expect(obsidian.plugin("quickadd").data<{ count: number }>().read()).resolves.toEqual({
      count: 2,
    });
  },
);

function createTransport(): CommandTransport {
  return async (request) => {
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

    if (command === "vault" && args.info === "name") {
      return createExecResult(request.bin, request.argv, "dev\n");
    }

    if (command === "plugin") {
      return createExecResult(request.bin, request.argv, "enabled\ttrue\n");
    }

    if (command === "plugin:reload") {
      return createExecResult(request.bin, request.argv, "");
    }

    if (command === "eval") {
      evalCalls.push(String(args.code ?? ""));
      return createExecResult(request.bin, request.argv, '{"ok":true,"value":true}\n');
    }

    throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
  };
}
