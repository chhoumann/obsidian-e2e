import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import "../src/matchers";
import type { ExecResult, ObsidianClient } from "../src/core/types";
import { createVaultApi } from "../src/vault/vault";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("obsidian-e2e matchers", () => {
  test("asserts file presence, content, and JSON readability", async () => {
    const vaultRoot = await createVaultRoot();
    const vault = createVaultApi({
      obsidian: createStubClient(vaultRoot),
    });

    await vault.write("note.md", "hello matcher");
    await vault.json("config.json").write({ enabled: true });

    await expect(vault).toHaveFile("note.md");
    await expect(vault).toHaveFileContaining("note.md", "matcher");
    await expect(vault).toHaveJsonFile("config.json");
  });
});

async function createVaultRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-matchers-"));
  tempDirectories.push(directory);
  return directory;
}

function createStubClient(vaultRoot: string): ObsidianClient {
  return {
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
    plugin() {
      throw new Error("plugin is not used in this test");
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
}
