import { promises as fs } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, expect } from "vite-plus/test";

import { createPluginTest } from "../../src/vitest";
import { createExecResult } from "../helpers/create-exec-result";
import { createTempDir } from "../helpers/create-temp-dir";
import type { CommandTransport } from "../../src/core/types";

let pluginDataPath = "";
let seededNotePath = "";
let vaultRoot = "";
const transportCalls: string[][] = [];

const pluginTest = createPluginTest({
  pluginFilter: "community",
  pluginId: "quickadd",
  seedPluginData: { count: 2 },
  seedVault: {
    "notes/seeded.md": {
      note: {
        body: "seeded content",
        frontmatter: {
          tags: ["seeded"],
        },
      },
    },
    "notes/state.json": { json: { ready: true } },
  },
  transport: createTransport(),
  vault: "dev",
});

beforeAll(async () => {
  vaultRoot = await createTempDir([], "obsidian-e2e-plugin-fixture-");
  pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
  seededNotePath = path.join(vaultRoot, "notes", "seeded.md");

  await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
  await fs.writeFile(pluginDataPath, `${JSON.stringify({ count: 1 }, null, 2)}\n`, "utf8");
});

afterAll(async () => {
  await expect(fs.readFile(pluginDataPath, "utf8")).resolves.toContain('"count": 1');
  await expect(fs.access(seededNotePath)).rejects.toThrow();
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

  await fs.rm(vaultRoot, { force: true, recursive: true });
});

pluginTest("injects plugin fixture and restores seeded state", async ({ plugin, vault }) => {
  expect(plugin.id).toBe("quickadd");
  await expect(vault.read("notes/seeded.md")).resolves.toBe(
    "---\ntags:\n  - seeded\n---\nseeded content",
  );
  await expect(vault.json<{ ready: boolean }>("notes/state.json").read()).resolves.toEqual({
    ready: true,
  });
  await expect(plugin.data<{ count: number }>().read()).resolves.toEqual({ count: 2 });
});

function createTransport(): CommandTransport {
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

    if (command === "commands") {
      return createExecResult(request.bin, request.argv, "plugin:reload\n");
    }

    if (command === "plugin") {
      return createExecResult(request.bin, request.argv, `enabled\t${enabled}\n`);
    }

    if (command === "plugin:enable") {
      enabled = true;
      return createExecResult(request.bin, request.argv, "");
    }

    if (command === "plugin:disable") {
      enabled = false;
      return createExecResult(request.bin, request.argv, "");
    }

    throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
  };
}
