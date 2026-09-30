import * as vitest from "vitest";
import type { TestContext } from "vitest";

import {
  captureFailureArtifacts,
  capturePluginFailureArtifacts,
} from "../artifacts/failure-artifacts";
import type { ObsidianClient, PluginHandle } from "../core/types";
import type { CreateObsidianTestOptions } from "./types";

type FailureContext = Pick<TestContext, "onTestFailed" | "onTestFinished" | "task">;
type Suite = NonNullable<FailureContext["task"]["suite"]> | FailureContext["task"]["file"];
type AfterEachHook = (context: Pick<TestContext, "task">) => unknown;
type GetSuiteHooks = (suite: Suite) => { afterEach: AfterEachHook[] };

// Bind to the consumer's runner ("vitest"), like the hooks in plugin-harness.ts.
// Vitest 4.1 exposes a suite's hooks as `TestRunner.getSuiteHooks`; older
// versions only through "vitest/suite", which Vitest 5 removed.
const runner = (vitest as unknown as { TestRunner?: { getSuiteHooks: GetSuiteHooks } }).TestRunner;
const getSuiteHooks: GetSuiteHooks =
  runner?.getSuiteHooks ??
  ((await import("vitest/suite")) as unknown as { getHooks: GetSuiteHooks }).getHooks;

/**
 * Runs `capture` once when the current test attempt fails, before the test's
 * own cleanup can change what is on screen. Call it from `beforeEach`.
 *
 * Vitest runs `afterEach` hooks, fixture teardown and `onTestFinished` before
 * `onTestFailed`, so a capture registered with `onTestFailed` alone records the
 * UI after cleanup has closed modals, removed notices and restored plugin data.
 * Vitest reads the test's suite's `afterEach` hooks when it calls them, before
 * any parent suite's, and runs the last added first (the default
 * `sequence.hooks: "stack"`) or the first added first (`"list"`). A hook added
 * at both ends of that list here therefore runs before every other cleanup,
 * once the test body has passed or failed. `onTestFailed` still covers
 * failures raised later, for example by an `afterEach` hook.
 */
export function captureOnTestFailure(
  context: FailureContext,
  capture: () => Promise<unknown>,
): void {
  const test = context.task;
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

  // `expect.soft` failures mark the test failed without throwing, so read the
  // result rather than catching. Concurrent tests share the suite's hooks.
  const captureIfFailed: AfterEachHook = async (hookContext) => {
    if (hookContext.task === test && test.result?.state === "fail") {
      await captureOnce();
    }
  };

  const hooks = getSuiteHooks(test.suite ?? test.file).afterEach;
  hooks.push(captureIfFailed);
  hooks.unshift(captureIfFailed);
  // Runs after the afterEach hooks, once per attempt; a retry runs beforeEach
  // and adds the hook again.
  context.onTestFinished(() => {
    for (
      let index = hooks.indexOf(captureIfFailed);
      index !== -1;
      index = hooks.indexOf(captureIfFailed)
    ) {
      hooks.splice(index, 1);
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
