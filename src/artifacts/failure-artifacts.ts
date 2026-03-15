import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ObsidianClient, PluginHandle } from "../core/types";
import { sanitizePathSegment } from "../core/path-slug";
import { parseNoteDocument } from "../note/document";
import { createVaultApi } from "../vault/vault";

export const DEFAULT_FAILURE_ARTIFACTS_DIR = ".obsidian-e2e-artifacts";

export interface FailureArtifactOptions {
  activeFile?: boolean;
  activeNote?: boolean;
  consoleMessages?: boolean;
  dom?: boolean;
  editorText?: boolean;
  notices?: boolean;
  parsedFrontmatter?: boolean;
  runtimeErrors?: boolean;
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

const DEFAULT_FAILURE_ARTIFACT_CAPTURE: Required<FailureArtifactOptions> = {
  activeFile: true,
  activeNote: true,
  consoleMessages: true,
  dom: true,
  editorText: true,
  notices: true,
  parsedFrontmatter: true,
  runtimeErrors: true,
  screenshot: true,
  tabs: true,
  workspace: true,
};

export function getFailureArtifactConfig(
  options: FailureArtifactRegistrationOptions,
): FailureArtifactConfig {
  if (!options.captureOnFailure) {
    return {
      artifactsDir: path.resolve(options.artifactsDir ?? DEFAULT_FAILURE_ARTIFACTS_DIR),
      capture: { ...DEFAULT_FAILURE_ARTIFACT_CAPTURE },
      enabled: false,
    };
  }

  const overrides = options.captureOnFailure === true ? {} : options.captureOnFailure;

  return {
    artifactsDir: path.resolve(options.artifactsDir ?? DEFAULT_FAILURE_ARTIFACTS_DIR),
    capture: { ...DEFAULT_FAILURE_ARTIFACT_CAPTURE, ...overrides },
    enabled: true,
  };
}

export function getFailureArtifactDirectory(
  artifactsDir: string,
  task: FailureArtifactTask,
): string {
  const suffix = task.id.split("_").at(-1) ?? "test";
  return path.join(artifactsDir, `${sanitizePathSegment(task.name, { maxLength: 60 })}-${suffix}`);
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
  const activeFile = await readActiveFilePath(obsidian);
  const activeNote = activeFile ? await readActiveNoteSnapshot(obsidian, activeFile) : null;
  const diagnostics = await obsidian.dev.diagnostics().catch(() => null);

  await Promise.all([
    captureJsonArtifact(
      artifactDirectory,
      "active-file.json",
      config.capture.activeFile,
      async () => ({
        activeFile,
      }),
    ),
    captureTextArtifact(
      artifactDirectory,
      "active-note.md",
      config.capture.activeNote,
      async () => activeNote?.raw ?? "",
    ),
    captureJsonArtifact(
      artifactDirectory,
      "active-note-frontmatter.json",
      config.capture.parsedFrontmatter,
      async () => ({
        frontmatter: activeNote?.frontmatter ?? null,
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
      text: await obsidian.dev.editorText(),
    })),
    captureJsonArtifact(
      artifactDirectory,
      "console-messages.json",
      config.capture.consoleMessages,
      async () => diagnostics?.consoleMessages ?? [],
    ),
    captureJsonArtifact(
      artifactDirectory,
      "runtime-errors.json",
      config.capture.runtimeErrors,
      async () => diagnostics?.runtimeErrors ?? [],
    ),
    captureJsonArtifact(
      artifactDirectory,
      "notices.json",
      config.capture.notices,
      async () => diagnostics?.notices ?? [],
    ),
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

export async function capturePluginFailureArtifacts(
  task: FailureArtifactTask,
  plugin: PluginHandle,
  options: FailureArtifactRegistrationOptions,
): Promise<string | undefined> {
  const config = getFailureArtifactConfig(options);

  if (!config.enabled) {
    return undefined;
  }

  const artifactDirectory = getFailureArtifactDirectory(config.artifactsDir, task);
  await mkdir(artifactDirectory, { recursive: true });
  await captureJsonArtifact(artifactDirectory, `${plugin.id}-data.json`, true, () =>
    plugin.data().read(),
  );

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

async function readActiveFilePath(obsidian: ObsidianClient): Promise<string | null> {
  return obsidian.dev.activeFilePath();
}

async function readActiveNoteSnapshot(obsidian: ObsidianClient, activeFile: string) {
  const vault = createVaultApi({ obsidian });
  const raw = await vault.read(activeFile);

  return parseNoteDocument(raw);
}
