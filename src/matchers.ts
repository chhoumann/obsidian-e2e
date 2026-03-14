import { isDeepStrictEqual } from "node:util";

import { expect } from "vite-plus/test";

import type { ObsidianClient, PluginHandle, SandboxApi, VaultApi } from "./core/types";

type FileMatcherTarget = SandboxApi | VaultApi;

expect.extend({
  async toHaveActiveFile(target: ObsidianClient, targetPath: string) {
    const actual = await target.dev.eval<string | null>(
      "app.workspace.getActiveFile()?.path ?? null",
    );
    const pass = actual === targetPath;

    return {
      message: () =>
        pass
          ? `Expected active file not to be "${targetPath}"`
          : `Expected active file to be "${targetPath}", received ${JSON.stringify(actual)}`,
      pass,
    };
  },
  async toHaveCommand(target: ObsidianClient, commandId: string) {
    const pass = await target.command(commandId).exists();

    return {
      message: () =>
        pass
          ? `Expected Obsidian command not to exist: ${commandId}`
          : `Expected Obsidian command to exist: ${commandId}`,
      pass,
    };
  },
  async toHaveFile(target: FileMatcherTarget, targetPath: string) {
    const pass = await target.exists(targetPath);

    return {
      message: () =>
        pass
          ? `Expected vault path not to exist: ${targetPath}`
          : `Expected vault path to exist: ${targetPath}`,
      pass,
    };
  },
  async toHaveFileContaining(target: FileMatcherTarget, targetPath: string, needle: string) {
    const exists = await target.exists(targetPath);

    if (!exists) {
      return {
        message: () => `Expected vault path to exist: ${targetPath}`,
        pass: false,
      };
    }

    const content = await target.read(targetPath);
    const pass = content.includes(needle);

    return {
      message: () =>
        pass
          ? `Expected vault path "${targetPath}" not to contain "${needle}"`
          : `Expected vault path "${targetPath}" to contain "${needle}"`,
      pass,
    };
  },
  async toHaveJsonFile(target: FileMatcherTarget, targetPath: string) {
    const exists = await target.exists(targetPath);

    if (!exists) {
      return {
        message: () => `Expected JSON file to exist: ${targetPath}`,
        pass: false,
      };
    }

    try {
      await target.json(targetPath).read();
      return {
        message: () => `Expected JSON file "${targetPath}" not to be valid JSON`,
        pass: true,
      };
    } catch (error) {
      return {
        message: () =>
          `Expected JSON file "${targetPath}" to be valid JSON, but parsing failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        pass: false,
      };
    }
  },
  async toHaveOpenTab(target: ObsidianClient, title: string, viewType?: string) {
    const tabs = await target.tabs();
    const pass = tabs.some(
      (tab) => tab.title === title && (viewType === undefined || tab.viewType === viewType),
    );

    return {
      message: () =>
        pass
          ? `Expected no open tab matching "${title}"${
              viewType ? ` with view type "${viewType}"` : ""
            }`
          : `Expected an open tab matching "${title}"${
              viewType ? ` with view type "${viewType}"` : ""
            }`,
      pass,
    };
  },
  async toHavePluginData(target: PluginHandle, expected: unknown) {
    const actual = await target.data().read();
    const pass = isDeepStrictEqual(actual, expected);

    return {
      message: () =>
        pass
          ? `Expected plugin data not to equal ${JSON.stringify(expected)}`
          : `Expected plugin data to equal ${JSON.stringify(expected)}, received ${JSON.stringify(
              actual,
            )}`,
      pass,
    };
  },
  async toHaveEditorTextContaining(target: ObsidianClient, needle: string) {
    const actual = await target.dev.eval<string | null>(
      "app.workspace.activeLeaf?.view?.editor?.getValue?.() ?? null",
    );
    const pass = typeof actual === "string" && actual.includes(needle);

    return {
      message: () =>
        pass
          ? `Expected editor text not to contain "${needle}"`
          : `Expected editor text to contain "${needle}", received ${JSON.stringify(actual)}`,
      pass,
    };
  },
  async toHaveWorkspaceNode(target: ObsidianClient, label: string) {
    const pass = hasWorkspaceNode(await target.workspace(), label);

    return {
      message: () =>
        pass
          ? `Expected workspace not to contain node "${label}"`
          : `Expected workspace to contain node "${label}"`,
      pass,
    };
  },
});

declare module "vite-plus/test" {
  interface Assertion<T = any> {
    toHaveActiveFile(path: string): Promise<T>;
    toHaveCommand(commandId: string): Promise<T>;
    toHaveEditorTextContaining(needle: string): Promise<T>;
    toHaveFile(path: string): Promise<T>;
    toHaveFileContaining(path: string, needle: string): Promise<T>;
    toHaveJsonFile(path: string): Promise<T>;
    toHaveOpenTab(title: string, viewType?: string): Promise<T>;
    toHavePluginData(expected: unknown): Promise<T>;
    toHaveWorkspaceNode(label: string): Promise<T>;
  }

  interface AsymmetricMatchersContaining {
    toHaveActiveFile(path: string): void;
    toHaveCommand(commandId: string): void;
    toHaveEditorTextContaining(needle: string): void;
    toHaveFile(path: string): void;
    toHaveFileContaining(path: string, needle: string): void;
    toHaveJsonFile(path: string): void;
    toHaveOpenTab(title: string, viewType?: string): void;
    toHavePluginData(expected: unknown): void;
    toHaveWorkspaceNode(label: string): void;
  }
}

export {};

function hasWorkspaceNode(
  nodes: Awaited<ReturnType<ObsidianClient["workspace"]>>,
  label: string,
): boolean {
  for (const node of nodes) {
    if (node.label === label || hasWorkspaceNode(node.children, label)) {
      return true;
    }
  }

  return false;
}
