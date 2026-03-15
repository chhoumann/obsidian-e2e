import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";
import type { OnTestFailedHandler } from "vite-plus/test";

import {
  captureFailureArtifacts,
  getFailureArtifactConfig,
  getFailureArtifactDirectory,
} from "../../src/artifacts/failure-artifacts";
import { createPluginHandle } from "../../src/core/plugin";
import {
  registerFailureArtifacts,
  registerPluginFailureArtifacts,
} from "../../src/fixtures/failure-artifacts";
import { createStubObsidianClient } from "../helpers/stub-obsidian-client";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("failure artifacts", () => {
  test("normalizes artifact config and creates deterministic directories", () => {
    const config = getFailureArtifactConfig({
      artifactsDir: ".artifacts",
      captureOnFailure: {
        screenshot: false,
      },
    });

    expect(config.enabled).toBe(true);
    expect(config.capture.screenshot).toBe(false);
    expect(config.capture.workspace).toBe(true);
    expect(
      getFailureArtifactDirectory("/tmp/artifacts", {
        id: "abc_12345678",
        name: "Captures artifacts for failures",
      }),
    ).toBe("/tmp/artifacts/captures-artifacts-for-failures-12345678");
  });

  test("captures core Obsidian artifacts on failure", async () => {
    const artifactsDir = await createTempDir("obsidian-e2e-artifacts-");
    const vaultRoot = await createTempDir("obsidian-e2e-artifacts-vault-");
    await fs.mkdir(path.join(vaultRoot, "Inbox"), { recursive: true });
    await fs.writeFile(
      path.join(vaultRoot, "Inbox", "Today.md"),
      "---\ntags:\n  - daily\n---\n# Today\n",
      "utf8",
    );
    const obsidian = createStubObsidianClient({
      activeFile: "Inbox/Today.md",
      consoleMessages: [{ args: ["saved"], at: 1, level: "log", text: "saved" }],
      domResult: "<div>Workspace</div>",
      editorText: "# Today",
      notices: [{ at: 2, message: "Saved" }],
      onScreenshot: async (targetPath) => {
        await fs.writeFile(targetPath, "png", "utf8");
        return targetPath;
      },
      runtimeErrors: [{ at: 3, message: "boom", source: "error" }],
      tabs: [{ id: "1", title: "Today", viewType: "markdown" }],
      vaultRoot,
      workspace: [{ children: [], id: "main", label: "main" }],
    });

    let failureHook: (() => Promise<void>) | undefined;
    const failureContext = {
      task: {
        id: "file_test_abcdef12",
        name: "writes useful artifacts",
      },
    };

    registerFailureArtifacts(
      {
        onTestFailed(fn: OnTestFailedHandler) {
          failureHook = () => Promise.resolve(fn(failureContext as never));
        },
        task: failureContext.task,
      } as never,
      obsidian,
      {
        artifactsDir,
        captureOnFailure: true,
      },
    );

    await failureHook?.();

    const artifactRoot = path.join(artifactsDir, "writes-useful-artifacts-abcdef12");
    await expect(
      fs.readFile(path.join(artifactRoot, "active-file.json"), "utf8"),
    ).resolves.toContain("Inbox/Today.md");
    await expect(fs.readFile(path.join(artifactRoot, "dom.txt"), "utf8")).resolves.toContain(
      "Workspace",
    );
    await expect(fs.readFile(path.join(artifactRoot, "active-note.md"), "utf8")).resolves.toContain(
      "# Today",
    );
    await expect(
      fs.readFile(path.join(artifactRoot, "active-note-frontmatter.json"), "utf8"),
    ).resolves.toContain('"daily"');
    await expect(
      fs.readFile(path.join(artifactRoot, "console-messages.json"), "utf8"),
    ).resolves.toContain('"saved"');
    await expect(fs.readFile(path.join(artifactRoot, "editor.json"), "utf8")).resolves.toContain(
      "# Today",
    );
    await expect(fs.readFile(path.join(artifactRoot, "notices.json"), "utf8")).resolves.toContain(
      '"Saved"',
    );
    await expect(
      fs.readFile(path.join(artifactRoot, "runtime-errors.json"), "utf8"),
    ).resolves.toContain('"boom"');
    await expect(fs.readFile(path.join(artifactRoot, "tabs.json"), "utf8")).resolves.toContain(
      '"Today"',
    );
    await expect(fs.readFile(path.join(artifactRoot, "workspace.json"), "utf8")).resolves.toContain(
      '"main"',
    );
    await expect(fs.readFile(path.join(artifactRoot, "screenshot.png"), "utf8")).resolves.toBe(
      "png",
    );
  });

  test("captures plugin data through the standalone API", async () => {
    const artifactsDir = await createTempDir("obsidian-e2e-plugin-artifacts-");
    const vaultRoot = await createTempDir("obsidian-e2e-plugin-vault-");
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, `${JSON.stringify({ enabled: true }, null, 2)}\n`, "utf8");

    const client = createStubObsidianClient({
      pluginFactory: createPluginHandle,
      readFileForRestore: (filePath) => fs.readFile(filePath, "utf8"),
      vaultRoot,
    });
    const plugin = client.plugin("quickadd");

    await captureFailureArtifacts(
      {
        id: "file_test_a1b2c3d4",
        name: "captures plugin data",
      },
      client,
      {
        artifactsDir,
        captureOnFailure: true,
        plugin,
      },
    );

    await expect(
      fs.readFile(
        path.join(artifactsDir, "captures-plugin-data-a1b2c3d4", "quickadd-data.json"),
        "utf8",
      ),
    ).resolves.toContain('"enabled": true');
  });

  test("captures plugin data without duplicating core artifacts", async () => {
    const artifactsDir = await createTempDir("obsidian-e2e-plugin-only-artifacts-");
    const vaultRoot = await createTempDir("obsidian-e2e-plugin-only-vault-");
    const pluginDataPath = path.join(vaultRoot, ".obsidian", "plugins", "quickadd", "data.json");
    await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
    await fs.writeFile(pluginDataPath, `${JSON.stringify({ enabled: true }, null, 2)}\n`, "utf8");
    await fs.mkdir(path.join(vaultRoot, "Inbox"), { recursive: true });
    await fs.writeFile(path.join(vaultRoot, "Inbox", "Today.md"), "# Today\n", "utf8");
    let screenshotCalls = 0;

    const client = createStubObsidianClient({
      activeFile: "Inbox/Today.md",
      consoleMessages: [{ args: ["hello"], at: 1, level: "log", text: "hello" }],
      domResult: "<div>Workspace</div>",
      editorText: "# Today",
      notices: [{ at: 2, message: "Saved" }],
      onScreenshot: async (targetPath) => {
        screenshotCalls += 1;
        await fs.writeFile(targetPath, "png", "utf8");
        return targetPath;
      },
      pluginFactory: createPluginHandle,
      readFileForRestore: (filePath) => fs.readFile(filePath, "utf8"),
      runtimeErrors: [{ at: 3, message: "boom", source: "error" }],
      vaultRoot,
    });
    const plugin = client.plugin("quickadd");

    let coreFailureHook: (() => Promise<void>) | undefined;
    let pluginFailureHook: (() => Promise<void>) | undefined;
    const failureContext = {
      task: {
        id: "file_test_plugin1234",
        name: "captures plugin fixture data once",
      },
    };

    registerFailureArtifacts(
      {
        onTestFailed(fn: OnTestFailedHandler) {
          coreFailureHook = () => Promise.resolve(fn(failureContext as never));
        },
        task: failureContext.task,
      } as never,
      client,
      {
        artifactsDir,
        captureOnFailure: true,
      },
    );

    registerPluginFailureArtifacts(
      {
        onTestFailed(fn: OnTestFailedHandler) {
          pluginFailureHook = () => Promise.resolve(fn(failureContext as never));
        },
        task: failureContext.task,
      } as never,
      plugin,
      {
        artifactsDir,
        captureOnFailure: true,
      },
    );

    await coreFailureHook?.();
    await pluginFailureHook?.();

    const artifactRoot = path.join(artifactsDir, "captures-plugin-fixture-data-once-plugin1234");

    await expect(
      fs.readFile(path.join(artifactRoot, "quickadd-data.json"), "utf8"),
    ).resolves.toContain('"enabled": true');
    await expect(
      fs.readFile(path.join(artifactRoot, "active-file.json"), "utf8"),
    ).resolves.toContain("Inbox/Today.md");
    await expect(fs.readFile(path.join(artifactRoot, "dom.txt"), "utf8")).resolves.toContain(
      "Workspace",
    );
    await expect(
      fs.readFile(path.join(artifactRoot, "console-messages.json"), "utf8"),
    ).resolves.toContain('"hello"');
    expect(screenshotCalls).toBe(1);
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}
