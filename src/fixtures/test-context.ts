import { createObsidianClient } from "../core/client";
import { getClientInternals } from "../core/internals";
import type { FailureArtifactTask } from "../artifacts/failure-artifacts";
import { captureFailureArtifacts } from "../artifacts/failure-artifacts";
import type { ObsidianClient, PluginHandle, VaultApi } from "../core/types";
import { createSandboxApi } from "../vault/sandbox";
import { createVaultApi } from "../vault/vault";
import { acquireVaultRunLock, clearVaultRunLockMarker, type VaultRunLock } from "./vault-lock";
import type { CreateObsidianTestOptions, PluginSessionOptions, TestContext } from "./types";

interface CreateInternalTestContextOptions extends CreateObsidianTestOptions {
  createVault?: (obsidian: ObsidianClient) => Promise<VaultApi> | VaultApi;
  testName?: string;
  vaultLock?: VaultRunLock | null;
}

interface TrackedPluginSession {
  filter?: PluginSessionOptions["filter"];
  plugin: PluginHandle;
  wasEnabled: boolean;
}

export async function createTestContext(
  options: CreateObsidianTestOptions & { testName?: string },
): Promise<TestContext> {
  return createInternalTestContext(options);
}

export async function withVaultSandbox<TResult>(
  options: CreateObsidianTestOptions & { testName?: string },
  run: (context: TestContext) => Promise<TResult> | TResult,
): Promise<TResult> {
  const context = await createInternalTestContext(options);

  try {
    return await run(context);
  } finally {
    await context.cleanup();
  }
}

export async function createInternalTestContext(
  options: CreateInternalTestContextOptions,
): Promise<TestContext> {
  const obsidian = createObsidianClient(options);
  const trackedPlugins = new Map<string, TrackedPluginSession>();
  let sandbox: Awaited<ReturnType<typeof createSandboxApi>> | null = null;
  const ownedLock = options.vaultLock ? null : await maybeAcquireVaultLock(options, obsidian);
  const vaultLock = options.vaultLock ?? ownedLock;
  const vaultFactory =
    options.createVault ?? ((client: ObsidianClient) => createVaultApi({ obsidian: client }));
  let disposed = false;

  try {
    await obsidian.verify();

    if (vaultLock) {
      await vaultLock.publishMarker(obsidian);
    }

    await obsidian.dev.resetDiagnostics().catch(() => {});

    const vault = await vaultFactory(obsidian);
    sandbox = await createSandboxApi({
      obsidian,
      sandboxRoot: options.sandboxRoot ?? "__obsidian_e2e__",
      testName: options.testName ?? "test",
    });

    const captureArtifacts = async (task: FailureArtifactTask) =>
      captureFailureArtifacts(task, obsidian, {
        ...options,
        plugin: trackedPlugins.size === 1 ? [...trackedPlugins.values()][0]!.plugin : undefined,
      });

    const cleanup: TestContext["cleanup"] = async (cleanupOptions = {}) => {
      if (disposed) {
        return;
      }

      disposed = true;

      try {
        if (cleanupOptions.failedTask && options.captureOnFailure) {
          await captureArtifacts(cleanupOptions.failedTask);
        }
      } finally {
        try {
          await getClientInternals(obsidian).restoreAll();
        } finally {
          for (const session of [...trackedPlugins.values()].reverse()) {
            if (!session.wasEnabled) {
              await session.plugin.disable({ filter: session.filter });
            }
          }

          try {
            await clearVaultRunLockMarker(obsidian);
          } catch {}

          if (ownedLock) {
            await ownedLock.release();
          }

          await sandbox!.cleanup();
        }
      }
    };

    return {
      obsidian,
      sandbox: sandbox!,
      vault,
      captureFailureArtifacts: captureArtifacts,
      cleanup,
      async plugin(id: string, sessionOptions: PluginSessionOptions = {}) {
        const existing = trackedPlugins.get(id);

        if (existing) {
          return existing.plugin;
        }

        const plugin = obsidian.plugin(id);
        const wasEnabled = await plugin.isEnabled();

        if (!wasEnabled) {
          await plugin.enable({ filter: sessionOptions.filter });
        }

        if (sessionOptions.seedData !== undefined) {
          await plugin.data().write(sessionOptions.seedData);
        }

        trackedPlugins.set(id, {
          filter: sessionOptions.filter,
          plugin,
          wasEnabled,
        });

        return plugin;
      },
      async resetDiagnostics() {
        await obsidian.dev.resetDiagnostics().catch(() => {});
      },
    };
  } catch (error) {
    try {
      if (sandbox) {
        await sandbox.cleanup();
      }
    } finally {
      try {
        await clearVaultRunLockMarker(obsidian);
      } catch {}

      if (ownedLock) {
        await ownedLock.release();
      }
    }

    throw error;
  }
}

async function maybeAcquireVaultLock(
  options: CreateObsidianTestOptions,
  obsidian: ObsidianClient,
): Promise<VaultRunLock | null> {
  if (!options.sharedVaultLock) {
    return null;
  }

  const lockOptions = options.sharedVaultLock === true ? {} : options.sharedVaultLock;

  return acquireVaultRunLock({
    ...lockOptions,
    vaultName: options.vault,
    vaultPath: await obsidian.vaultPath(),
  });
}
