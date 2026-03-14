import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, expect } from "vite-plus/test";

import { createObsidianTest } from "../../src/vitest";
import type { CommandTransport, ExecResult } from "../../src/core/types";

let sandboxRootPath = "";
let vaultRoot = "";

const fixtureTest = createObsidianTest({
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
    await expect(obsidian.plugin("quickadd").data<{ count: number }>().read()).resolves.toEqual({
      count: 2,
    });
  },
);

function createTransport(): CommandTransport {
  return async (request) => {
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
      return createResult(request.bin, request.argv, `${vaultRoot}\n`);
    }

    if (command === "vault" && args.info === "name") {
      return createResult(request.bin, request.argv, "dev\n");
    }

    if (command === "plugin") {
      return createResult(request.bin, request.argv, "enabled\ttrue\n");
    }

    if (command === "plugin:reload") {
      return createResult(request.bin, request.argv, "");
    }

    throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
  };
}

function createResult(command: string, argv: string[], stdout: string): ExecResult {
  return {
    argv,
    command,
    exitCode: 0,
    stderr: "",
    stdout,
  };
}
