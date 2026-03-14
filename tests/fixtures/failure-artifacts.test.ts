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
    const obsidian = createStubObsidianClient({
      activeFile: "Inbox/Today.md",
      domResult: "<div>Workspace</div>",
      editorText: "# Today",
      onScreenshot: async (targetPath) => {
        await fs.writeFile(targetPath, "png", "utf8");
        return targetPath;
      },
      tabs: [{ id: "1", title: "Today", viewType: "markdown" }],
      vaultRoot: "/tmp/vault",
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
    await expect(fs.readFile(path.join(artifactRoot, "editor.json"), "utf8")).resolves.toContain(
      "# Today",
    );
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
    const evalCalls: string[] = [];
    let screenshotCalls = 0;

    const client = createStubObsidianClient({
      activeFile: "Inbox/Today.md",
      domResult: "<div>Workspace</div>",
      editorText: "# Today",
      onEval: async (code) => {
        evalCalls.push(code);

        if (code === "app.workspace.getActiveFile()?.path ?? null") {
          return "Inbox/Today.md";
        }

        if (code === "app.workspace.activeLeaf?.view?.editor?.getValue?.() ?? null") {
          return "# Today";
        }

        throw new Error(`Unhandled dev.eval code: ${code}`);
      },
      onScreenshot: async (targetPath) => {
        screenshotCalls += 1;
        await fs.writeFile(targetPath, "png", "utf8");
        return targetPath;
      },
      pluginFactory: createPluginHandle,
      readFileForRestore: (filePath) => fs.readFile(filePath, "utf8"),
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
    expect(evalCalls).toHaveLength(2);
    expect(screenshotCalls).toBe(1);
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}
