import type { TestContext } from "vite-plus/test";

import {
  captureFailureArtifacts,
  capturePluginFailureArtifacts,
} from "../artifacts/failure-artifacts";
import type { ObsidianClient, PluginHandle } from "../core/types";
import type { CreateObsidianTestOptions } from "./types";

export function registerFailureArtifacts(
  context: Pick<TestContext, "onTestFailed" | "task">,
  obsidian: ObsidianClient,
  options: Pick<CreateObsidianTestOptions, "artifactsDir" | "captureOnFailure">,
  plugin?: PluginHandle,
): void {
  if (!options.captureOnFailure) {
    return;
  }

  context.onTestFailed(async () => {
    await captureFailureArtifacts(context.task, obsidian, {
      ...options,
      plugin,
    });
  });
}

export function registerPluginFailureArtifacts(
  context: Pick<TestContext, "onTestFailed" | "task">,
  plugin: PluginHandle,
  options: Pick<CreateObsidianTestOptions, "artifactsDir" | "captureOnFailure">,
): void {
  if (!options.captureOnFailure) {
    return;
  }

  context.onTestFailed(async () => {
    await capturePluginFailureArtifacts(context.task, plugin, options);
  });
}
