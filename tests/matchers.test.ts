import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import "../src/matchers";
import { createPluginHandle } from "../src/core/plugin";
import type { ObsidianClient, WorkspaceNode, WorkspaceTab } from "../src/core/types";
import { createVaultApi } from "../src/vault/vault";
import { createStubObsidianClient } from "./helpers/stub-obsidian-client";

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

  test("asserts available commands and open tabs", async () => {
    const obsidian = createStubClient("/tmp/vault", {
      activeFile: "Inbox/Today.md",
      commands: ["workspace:save", "quickadd:run-choice"],
      editorText: "Today\nScratchpad",
      tabs: [
        { id: "1", title: "Scratchpad", viewType: "markdown" },
        { id: "2", title: "Search", viewType: "search" },
      ],
      workspace: [
        {
          children: [
            {
              children: [],
              id: "2",
              label: "Scratchpad",
              title: "Scratchpad",
              viewType: "markdown",
            },
          ],
          id: "main",
          label: "main",
        },
      ],
    });

    await expect(obsidian).toHaveActiveFile("Inbox/Today.md");
    await expect(obsidian).toHaveCommand("quickadd:run-choice");
    await expect(obsidian).toHaveEditorTextContaining("Scratchpad");
    await expect(obsidian).toHaveOpenTab("Scratchpad", "markdown");
    await expect(obsidian).toHaveWorkspaceNode("main");
  });

  test("asserts plugin data equality", async () => {
    const vaultRoot = await createVaultRoot();
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, `${JSON.stringify({ enabled: true }, null, 2)}\n`, "utf8");

    const plugin = createPluginHandle(createStubClient(vaultRoot), "quickadd");

    await expect(plugin).toHavePluginData({ enabled: true });
  });
});

async function createVaultRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-matchers-"));
  tempDirectories.push(directory);
  return directory;
}

function createStubClient(
  vaultRoot: string,
  overrides: {
    activeFile?: string | null;
    commands?: string[];
    editorText?: string | null;
    tabs?: WorkspaceTab[];
    workspace?: WorkspaceNode[];
  } = {},
): ObsidianClient {
  return createStubObsidianClient({
    activeFile: overrides.activeFile,
    commands: overrides.commands,
    editorText: overrides.editorText,
    pluginFactory: createPluginHandle,
    tabs: overrides.tabs,
    vaultRoot,
    workspace: overrides.workspace,
  });
}
