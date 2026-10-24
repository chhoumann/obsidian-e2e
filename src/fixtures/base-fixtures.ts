import type { TestContext } from "vitest";

import { createObsidianClient } from "../core/client";
import type { ObsidianClient, VaultApi } from "../core/types";
import { createVaultApi } from "../vault/vault";
import { createInternalTestContext } from "./test-context";
import type { CreateObsidianTestOptions, TestContext as ObsidianTestContext } from "./types";
import { acquireVaultRunLock, clearVaultRunLockMarker, type VaultRunLock } from "./vault-lock";

export const DEFAULT_SANDBOX_ROOT = "__obsidian_e2e__";

export interface BaseFixtureState {
  _testContext: ObsidianTestContext;
  _vaultLock: VaultRunLock | null;
}

type Use<T> = (value: T) => Promise<void>;

interface BaseFixtures {
  _vaultLock: [
    (context: object, use: Use<VaultRunLock | null>) => Promise<void>,
    { scope: "worker" },
  ];
  _testContext: (
    context: Pick<BaseFixtureState & TestContext, "_vaultLock" | "task">,
    use: Use<ObsidianTestContext>,
  ) => Promise<void>;
  obsidian: (
    context: Pick<BaseFixtureState, "_testContext">,
    use: Use<ObsidianClient>,
  ) => Promise<void>;
  sandbox: (
    context: Pick<BaseFixtureState, "_testContext">,
    use: Use<ObsidianTestContext["sandbox"]>,
  ) => Promise<void>;
  vault: (context: Pick<BaseFixtureState, "_testContext">, use: Use<VaultApi>) => Promise<void>;
}

interface BaseFixtureOptions {
  createVault?: (obsidian: ObsidianClient) => Promise<VaultApi> | VaultApi;
}

export function createBaseFixtures(
  options: CreateObsidianTestOptions,
  fixtureOptions: BaseFixtureOptions = {},
): BaseFixtures {
  const createVault =
    fixtureOptions.createVault ?? ((obsidian: ObsidianClient) => createVaultApi({ obsidian }));

  return {
    _vaultLock: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        if (!options.sharedVaultLock) {
          await use(null);
          return;
        }

        const lockClient = createObsidianClient(options);
        await lockClient.verify();

        const lockOptions = options.sharedVaultLock === true ? {} : options.sharedVaultLock;
        const vaultLock = await acquireVaultRunLock({
          ...lockOptions,
          vaultName: options.vault,
          vaultPath: await lockClient.vaultPath(),
        });

        await vaultLock.publishMarker(lockClient);

        let useFailure: { error: unknown } | undefined;

        try {
          await use(vaultLock);
        } catch (error) {
          useFailure = { error };
        }

        // Warn, finish releasing the lock, then fail the suite: a dead eval
        // path here means Obsidian retains stale ownership metadata, which
        // must not look like a clean run
        // (https://github.com/chhoumann/obsidian-e2e/issues/19).
        let markerClearFailure: { error: unknown } | undefined;

        try {
          await clearVaultRunLockMarker(lockClient);
        } catch (error) {
          markerClearFailure = { error };
          console.warn("Failed to clear the vault run lock marker during teardown", error);
        }

        await vaultLock.release();

        if (useFailure) {
          throw useFailure.error;
        }

        if (markerClearFailure) {
          throw markerClearFailure.error;
        }
      },
      { scope: "worker" },
    ],
    _testContext: async ({ _vaultLock, task }, use) => {
      const context = await createInternalTestContext({
        ...options,
        createVault,
        testName: task.name,
        vaultLock: _vaultLock,
      });

      try {
        await use(context);
      } finally {
        // Vitest tears fixtures down before it calls `onTestFailed`, so read the
        // result directly. The test body and `afterEach` hooks have already run.
        await context.cleanup({
          failedTask: task.result?.state === "fail" ? task : undefined,
        });
      }
    },
    obsidian: async ({ _testContext }, use) => {
      await use(_testContext.obsidian);
    },
    sandbox: async ({ _testContext }, use) => {
      await use(_testContext.sandbox);
    },
    vault: async ({ _testContext }, use) => {
      await use(_testContext.vault);
    },
  };
}
