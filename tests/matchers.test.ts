import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import "../src/matchers";
import { createPluginHandle } from "../src/core/plugin";
import type {
  MetadataFileCache,
  NoteFrontmatter,
  ObsidianClient,
  WorkspaceNode,
  WorkspaceTab,
} from "../src/core/types";
import { createSandboxApi } from "../src/vault/sandbox";
import { createVaultApi } from "../src/vault/vault";
import {
  cleanupTempDirectories,
  createTempDir as createTrackedTempDir,
} from "./helpers/create-temp-dir";
import { createStubObsidianClient } from "./helpers/stub-obsidian-client";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
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

  test("asserts note shape and file-derived frontmatter", async () => {
    const vaultRoot = await createVaultRoot();
    const obsidian = createStubClient(vaultRoot);
    const sandbox = await createSandboxApi({
      obsidian,
      sandboxRoot: "__obsidian_e2e__",
      testName: "Matchers",
    });

    await sandbox.write("note.md", "---\ntitle: Daily\n---\nBody\n");

    await expect(sandbox).toHaveNote("note.md", {
      bodyIncludes: "Body",
      frontmatter: {
        title: "Daily",
      },
    });
    await expect(sandbox).toHaveFrontmatter("note.md", {
      title: "Daily",
    });
  });
});

async function createVaultRoot(): Promise<string> {
  return createTrackedTempDir(tempDirectories, "obsidian-e2e-matchers-");
}

function createStubClient(
  vaultRoot: string,
  overrides: {
    activeFile?: string | null;
    commands?: string[];
    editorText?: string | null;
    metadataByPath?: Record<string, MetadataFileCache<NoteFrontmatter> | null>;
    tabs?: WorkspaceTab[];
    workspace?: WorkspaceNode[];
  } = {},
): ObsidianClient {
  return createStubObsidianClient({
    activeFile: overrides.activeFile,
    commands: overrides.commands,
    editorText: overrides.editorText,
    metadataByPath: overrides.metadataByPath,
    pluginFactory: createPluginHandle,
    tabs: overrides.tabs,
    vaultRoot,
    workspace: overrides.workspace,
  });
}
