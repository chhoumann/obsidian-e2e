import type { TestContext } from "vitest";
// Bind to "vitest/suite" (the consumer's runner), like the hooks in plugin-harness.ts.
import { getFn, setFn } from "vitest/suite";

import {
  captureFailureArtifacts,
  capturePluginFailureArtifacts,
} from "../artifacts/failure-artifacts";
import type { ObsidianClient, PluginHandle } from "../core/types";
import type { CreateObsidianTestOptions } from "./types";

type FailureContext = Pick<TestContext, "onTestFailed" | "task">;

/**
 * Runs `capture` once when the current test attempt fails, before the test's
 * own cleanup can change what is on screen. Call it from `beforeEach`.
 *
 * Vitest runs `afterEach` hooks, fixture teardown and `onTestFinished` before
 * `onTestFailed`, so a capture registered with `onTestFailed` alone records the
 * UI after cleanup has closed modals, removed notices and restored plugin data.
 * Vitest reads the test function after the `beforeEach` hooks, so wrapping it
 * here captures as soon as the test body fails. `onTestFailed` still covers
 * failures raised later, for example by an `afterEach` hook.
 */
export function captureOnTestFailure(
  context: FailureContext,
  capture: () => Promise<unknown>,
): void {
  const test = context.task as Parameters<typeof setFn>[0];
  const run = getFn(test);
  let captured = false;

  const captureOnce = async () => {
    if (captured) {
      return;
    }

    captured = true;
    await capture().catch((error: unknown) => {
      console.warn(`Failure artifact capture failed for "${test.name}"`, error);
    });
  };

  setFn(test, async () => {
    try {
      await run();
    } catch (error) {
      await captureOnce();
      throw error;
    } finally {
      // A retry runs beforeEach again and must wrap the original function.
      setFn(test, run);
    }

    // `expect.soft` failures mark the test failed without throwing.
    if (test.result?.state === "fail") {
      await captureOnce();
    }
  });

  context.onTestFailed(captureOnce);
}

export function registerFailureArtifacts(
  context: FailureContext,
  obsidian: ObsidianClient,
  options: Pick<CreateObsidianTestOptions, "artifactsDir" | "captureOnFailure">,
  plugin?: PluginHandle,
): void {
  if (!options.captureOnFailure) {
    return;
  }

  captureOnTestFailure(context, () =>
    captureFailureArtifacts(context.task, obsidian, {
      ...options,
      plugin,
    }),
  );
}

export function registerPluginFailureArtifacts(
  context: FailureContext,
  plugin: PluginHandle,
  options: Pick<CreateObsidianTestOptions, "artifactsDir" | "captureOnFailure">,
): void {
  if (!options.captureOnFailure) {
    return;
  }

  captureOnTestFailure(context, () => capturePluginFailureArtifacts(context.task, plugin, options));
}
