import { readlink } from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach } from "vite-plus/test";
import type { TestContext as VitestTestContext } from "vite-plus/test";

import type { FailureArtifactTask } from "../artifacts/failure-artifacts";
import type {
  ObsidianClient,
  PluginHandle,
  PluginToggleOptions,
  PluginWaitUntilReadyOptions,
  SandboxApi,
} from "../core/types";
import { verifyVaultPath } from "../env/resolve-env";
import { createInternalTestContext } from "./test-context";
import type { CreateObsidianTestOptions, TestContext } from "./types";

const DEFAULT_SETUP_TIMEOUT_MS = 90_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_RELOAD_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 200;
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

export interface PluginHarnessContext {
  obsidian: ObsidianClient;
  plugin: PluginHandle;
  sandbox: SandboxApi;
}

export interface PluginHarnessReloadOptions {
  intervalMs?: number;
  readyCommandId?: string;
  timeoutMs?: number;
}

export interface CreatePluginHarnessOptions extends CreateObsidianTestOptions {
  /**
   * Runs before every `plugin.restoreData()` (per-test and at teardown), while
   * the plugin is still enabled - the seam for plugin-specific flushing or view
   * detaching that must complete before the settings file is rolled back.
   */
  beforeDataRestore?: (obsidian: ObsidianClient) => void | Promise<void>;
  /** Expected CLI-resolved vault path; a mismatch fails the suite in setup. */
  expectedVaultPath?: string;
  pluginFilter?: PluginToggleOptions["filter"];
  pluginId: string;
  reload?: PluginHarnessReloadOptions;
  /** `beforeAll` timeout in ms. Defaults to 90000. */
  setupTimeoutMs?: number;
  /**
   * Optional dev-vault symlink preflight: asserts each artifact under
   * `<vault>/.obsidian/plugins/<pluginId>/` is a symlink into `symlinkRepoRoot`.
   */
  symlinkArtifacts?: string[];
  /** Root the symlinked artifacts must point at. Defaults to `process.cwd()`. */
  symlinkRepoRoot?: string;
  /** `afterAll` timeout in ms. Defaults to 30000. */
  teardownTimeoutMs?: number;
  /** Extra readiness predicate beyond plugin-loaded and the ready command. */
  waitUntilReady?: (obsidian: ObsidianClient) => boolean | Promise<boolean>;
}

export interface PluginHarnessSession {
  captureFailure(task: FailureArtifactTask): Promise<void>;
  getContext(): PluginHarnessContext;
  resetDiagnostics(): Promise<void>;
  restoreData(): Promise<void>;
  setup(): Promise<void>;
  teardown(): Promise<void>;
}

/**
 * Suite-scoped harness for a single plugin: one vault lock, one sandbox, one
 * reload for the whole file, with per-test diagnostics reset and data restore.
 *
 * `createPluginHarness(options)` returns a `(testName) => () => context` factory
 * matching the getter shape the hand-rolled per-repo harnesses already expose,
 * so consumer test bodies migrate untouched.
 */
export function createPluginHarness(
  options: CreatePluginHarnessOptions,
): (testName: string) => () => PluginHarnessContext {
  const setupTimeoutMs = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;

  return (testName: string): (() => PluginHarnessContext) => {
    const session = createPluginHarnessSession(options, testName);

    beforeAll(() => session.setup(), setupTimeoutMs);

    beforeEach((ctx: VitestTestContext) => {
      ctx.onTestFailed(async () => {
        await session.captureFailure({ id: ctx.task.id, name: ctx.task.name }).catch((error) => {
          console.warn(`Plugin "${options.pluginId}" harness artifact capture failed`, error);
        });
      });
    });

    beforeEach(() => session.resetDiagnostics());

    afterEach(() => session.restoreData());

    afterAll(() => session.teardown(), teardownTimeoutMs);

    return () => session.getContext();
  };
}

/**
 * Lifecycle for one harness instance without registering any vitest hooks - the
 * seam `createPluginHarness` drives and tests exercise directly.
 */
export function createPluginHarnessSession(
  options: CreatePluginHarnessOptions,
  testName: string,
): PluginHarnessSession {
  const {
    beforeDataRestore,
    expectedVaultPath,
    pluginFilter,
    pluginId,
    reload,
    setupTimeoutMs: _setupTimeoutMs,
    symlinkArtifacts,
    symlinkRepoRoot,
    teardownTimeoutMs: _teardownTimeoutMs,
    waitUntilReady,
    ...testOptions
  } = options;

  const readyWaitOptions: PluginWaitUntilReadyOptions = {
    commandId: reload?.readyCommandId,
    intervalMs: reload?.intervalMs ?? DEFAULT_READY_INTERVAL_MS,
    predicate: waitUntilReady,
    timeoutMs: reload?.timeoutMs ?? DEFAULT_RELOAD_TIMEOUT_MS,
  };

  const needsPreflight = Boolean(expectedVaultPath || symlinkArtifacts?.length);

  let context: TestContext | undefined;
  let plugin: PluginHandle | undefined;
  let ready = false;

  async function runPreflight(obsidian: ObsidianClient): Promise<void> {
    const vaultPath = await obsidian.vaultPath();

    if (expectedVaultPath) {
      verifyVaultPath({ actualVaultPath: vaultPath, expectedVaultPath, vaultName: options.vault });
    }

    if (symlinkArtifacts?.length) {
      await assertPluginArtifactSymlinks({
        artifacts: symlinkArtifacts,
        pluginId,
        repoRoot: symlinkRepoRoot ?? process.cwd(),
        vaultPath,
      });
    }
  }

  async function restorePluginData(): Promise<void> {
    if (!context || !plugin) {
      return;
    }

    await beforeDataRestore?.(context.obsidian);
    await plugin.disable({ filter: pluginFilter });
    await plugin.restoreData();
    await plugin.enable({ filter: pluginFilter });
    await plugin.waitUntilReady(readyWaitOptions);
  }

  return {
    async captureFailure(task: FailureArtifactTask): Promise<void> {
      if (!context) {
        return;
      }

      await context.captureFailureArtifacts(task);
    },
    getContext(): PluginHarnessContext {
      if (!ready || !context || !plugin) {
        throw new Error(`Plugin "${pluginId}" harness is not initialized.`);
      }

      return { obsidian: context.obsidian, plugin, sandbox: context.sandbox };
    },
    async resetDiagnostics(): Promise<void> {
      await context?.resetDiagnostics();
    },
    restoreData: restorePluginData,
    async setup(): Promise<void> {
      context = await createInternalTestContext({
        ...testOptions,
        beforeSandbox: needsPreflight ? runPreflight : undefined,
        sharedVaultLock: testOptions.sharedVaultLock ?? {
          onBusy: "wait",
          timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
        },
        testName,
      });

      plugin = await context.plugin(pluginId, { filter: pluginFilter });

      await plugin.reload({
        readyOptions: readyWaitOptions,
        waitUntilReady: true,
      });

      ready = true;
    },
    async teardown(): Promise<void> {
      const errors: unknown[] = [];

      await runTeardown(pluginId, "restore plugin data", errors, restorePluginData);
      await runTeardown(pluginId, "clean up harness context", errors, () => context?.cleanup());

      ready = false;

      if (errors.length === 1) {
        throw errors[0];
      }

      if (errors.length > 1) {
        throw new AggregateError(errors, `Plugin "${pluginId}" harness teardown failed.`);
      }
    },
  };
}

interface AssertPluginArtifactSymlinksOptions {
  artifacts: string[];
  pluginId: string;
  repoRoot: string;
  vaultPath: string;
}

async function assertPluginArtifactSymlinks({
  artifacts,
  pluginId,
  repoRoot,
  vaultPath,
}: AssertPluginArtifactSymlinksOptions): Promise<void> {
  const pluginDir = path.join(vaultPath, ".obsidian", "plugins", pluginId);

  for (const fileName of artifacts) {
    const linkPath = path.join(pluginDir, fileName);
    const expected = path.join(repoRoot, fileName);
    let target: string;

    try {
      target = await readlink(linkPath);
    } catch (error) {
      throw new Error(
        [
          `Plugin "${pluginId}" E2E preflight failed.`,
          `Expected ${linkPath} to be a symlink to ${expected}.`,
          `Could not read symlink: ${error instanceof Error ? error.message : String(error)}`,
        ].join(" "),
      );
    }

    const resolvedTarget = path.resolve(path.dirname(linkPath), target);

    if (resolvedTarget !== expected) {
      throw new Error(
        [
          `Plugin "${pluginId}" E2E preflight failed.`,
          `Expected ${linkPath} to point at ${expected}.`,
          `It currently points at ${resolvedTarget}.`,
          "Repoint the dev vault plugin symlink intentionally before running the E2E suite.",
        ].join(" "),
      );
    }
  }
}

async function runTeardown(
  pluginId: string,
  label: string,
  errors: unknown[],
  step: () => unknown,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    errors.push(error);
    console.warn(`Plugin "${pluginId}" harness teardown failed during ${label}`, error);
  }
}
