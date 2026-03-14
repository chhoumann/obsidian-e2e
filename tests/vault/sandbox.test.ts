import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { createSandboxApi } from "../../src/vault/sandbox";
import { createVaultApi } from "../../src/vault/vault";
import type { ObsidianClient } from "../../src/core/types";
import { createStubObsidianClient } from "../helpers/stub-obsidian-client";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("createVaultApi", () => {
  test("reads and writes files relative to the vault root", async () => {
    const vaultRoot = await createVaultRoot();
    const vault = createVaultApi({
      obsidian: createStubClient(vaultRoot),
      root: "__obsidian_e2e__/case-a",
    });

    await vault.write("note.md", "hello");

    await expect(vault.read("note.md")).resolves.toBe("hello");
    await expect(
      fs.readFile(path.join(vaultRoot, "__obsidian_e2e__", "case-a", "note.md"), "utf8"),
    ).resolves.toBe("hello");
  });
});

describe("createSandboxApi", () => {
  test("creates a unique scoped root and cleans it up", async () => {
    const vaultRoot = await createVaultRoot();
    const sandbox = await createSandboxApi({
      obsidian: createStubClient(vaultRoot),
      sandboxRoot: "__obsidian_e2e__",
      testName: "Preserves leading zeros",
    });

    await sandbox.write("tpl.md", "hello");

    const expectedPath = path.join(vaultRoot, sandbox.root, "tpl.md");
    await expect(fs.readFile(expectedPath, "utf8")).resolves.toBe("hello");
    expect(sandbox.root).toMatch(/^__obsidian_e2e__\/preserves-leading-zeros-[a-f0-9]{8}$/);
    expect(sandbox.path("tpl.md")).toBe(`${sandbox.root}/tpl.md`);

    await sandbox.cleanup();

    await expect(fs.access(path.join(vaultRoot, sandbox.root))).rejects.toThrow();
  });
});

async function createVaultRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-vault-"));
  tempDirectories.push(directory);
  return directory;
}

function createStubClient(vaultRoot: string): ObsidianClient {
  return createStubObsidianClient({ vaultRoot });
}
