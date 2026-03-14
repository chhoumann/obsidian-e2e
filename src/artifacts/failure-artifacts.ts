import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ObsidianClient, PluginHandle } from "../core/types";

export const DEFAULT_FAILURE_ARTIFACTS_DIR = ".obsidian-e2e-artifacts";

export interface FailureArtifactOptions {
  activeFile?: boolean;
  dom?: boolean;
  editorText?: boolean;
  screenshot?: boolean;
  tabs?: boolean;
  workspace?: boolean;
}

export interface FailureArtifactTask {
  id: string;
  name: string;
}

export interface FailureArtifactConfig {
  artifactsDir: string;
  capture: Required<FailureArtifactOptions>;
  enabled: boolean;
}

export interface FailureArtifactRegistrationOptions {
  artifactsDir?: string;
  captureOnFailure?: boolean | FailureArtifactOptions;
}

export interface CaptureFailureArtifactsOptions extends FailureArtifactRegistrationOptions {
  plugin?: PluginHandle;
}

export function getFailureArtifactConfig(
  options: FailureArtifactRegistrationOptions,
): FailureArtifactConfig {
  if (!options.captureOnFailure) {
    return {
      artifactsDir: path.resolve(options.artifactsDir ?? DEFAULT_FAILURE_ARTIFACTS_DIR),
      capture: {
        activeFile: true,
        dom: true,
        editorText: true,
        screenshot: true,
        tabs: true,
        workspace: true,
      },
      enabled: false,
    };
  }

  const overrides = options.captureOnFailure === true ? {} : options.captureOnFailure;

  return {
    artifactsDir: path.resolve(options.artifactsDir ?? DEFAULT_FAILURE_ARTIFACTS_DIR),
    capture: {
      activeFile: overrides.activeFile ?? true,
      dom: overrides.dom ?? true,
      editorText: overrides.editorText ?? true,
      screenshot: overrides.screenshot ?? true,
      tabs: overrides.tabs ?? true,
      workspace: overrides.workspace ?? true,
    },
    enabled: true,
  };
}

export function getFailureArtifactDirectory(
  artifactsDir: string,
  task: FailureArtifactTask,
): string {
  const suffix = task.id.split("_").at(-1) ?? "test";
  return path.join(artifactsDir, `${sanitizeForPath(task.name)}-${suffix}`);
}

export async function captureFailureArtifacts(
  task: FailureArtifactTask,
  obsidian: ObsidianClient,
  options: CaptureFailureArtifactsOptions,
): Promise<string | undefined> {
  const config = getFailureArtifactConfig(options);

  if (!config.enabled) {
    return undefined;
  }

  const artifactDirectory = getFailureArtifactDirectory(config.artifactsDir, task);
  await mkdir(artifactDirectory, { recursive: true });

  await Promise.all([
    captureJsonArtifact(
      artifactDirectory,
      "active-file.json",
      config.capture.activeFile,
      async () => ({
        activeFile: await obsidian.dev.eval<string | null>(
          "app.workspace.getActiveFile()?.path ?? null",
        ),
      }),
    ),
    captureTextArtifact(artifactDirectory, "dom.txt", config.capture.dom, async () =>
      String(
        await obsidian.dev.dom({
          inner: true,
          selector: ".workspace",
        }),
      ),
    ),
    captureJsonArtifact(artifactDirectory, "editor.json", config.capture.editorText, async () => ({
      text: await obsidian.dev.eval<string | null>(
        "app.workspace.activeLeaf?.view?.editor?.getValue?.() ?? null",
      ),
    })),
    captureScreenshotArtifact(artifactDirectory, config.capture.screenshot, obsidian),
    captureJsonArtifact(artifactDirectory, "tabs.json", config.capture.tabs, () => obsidian.tabs()),
    captureJsonArtifact(artifactDirectory, "workspace.json", config.capture.workspace, () =>
      obsidian.workspace(),
    ),
    options.plugin
      ? captureJsonArtifact(artifactDirectory, `${options.plugin.id}-data.json`, true, () =>
          options.plugin!.data().read(),
        )
      : Promise.resolve(),
  ]);

  return artifactDirectory;
}

async function captureJsonArtifact(
  artifactDirectory: string,
  filename: string,
  enabled: boolean,
  readValue: () => Promise<unknown>,
): Promise<void> {
  if (!enabled) {
    return;
  }

  try {
    const value = await readValue();
    await writeFile(
      path.join(artifactDirectory, filename),
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    await writeFile(
      path.join(artifactDirectory, `${filename}.error.txt`),
      formatArtifactError(error),
      "utf8",
    );
  }
}

async function captureScreenshotArtifact(
  artifactDirectory: string,
  enabled: boolean,
  obsidian: ObsidianClient,
): Promise<void> {
  if (!enabled) {
    return;
  }

  const screenshotPath = path.join(artifactDirectory, "screenshot.png");

  try {
    await obsidian.dev.screenshot(screenshotPath);
  } catch (error) {
    await writeFile(
      path.join(artifactDirectory, "screenshot.error.txt"),
      formatArtifactError(error),
      "utf8",
    );
  }
}

async function captureTextArtifact(
  artifactDirectory: string,
  filename: string,
  enabled: boolean,
  readValue: () => Promise<string>,
): Promise<void> {
  if (!enabled) {
    return;
  }

  try {
    await writeFile(path.join(artifactDirectory, filename), await readValue(), "utf8");
  } catch (error) {
    await writeFile(
      path.join(artifactDirectory, `${filename}.error.txt`),
      formatArtifactError(error),
      "utf8",
    );
  }
}

function formatArtifactError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}\n` : `${String(error)}\n`;
}

function sanitizeForPath(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "test"
  );
}
