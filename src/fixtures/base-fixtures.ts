import type { TestContext } from "vite-plus/test";

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

interface BaseFixtureOptions {
  createVault?: (obsidian: ObsidianClient) => Promise<VaultApi> | VaultApi;
}

export function createBaseFixtures(
  options: CreateObsidianTestOptions,
  fixtureOptions: BaseFixtureOptions = {},
) {
  const createVault =
    fixtureOptions.createVault ?? ((obsidian: ObsidianClient) => createVaultApi({ obsidian }));

  return {
    _vaultLock: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use: (vaultLock: VaultRunLock | null) => Promise<void>) => {
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
        try {
          await use(vaultLock);
        } finally {
          try {
            await clearVaultRunLockMarker(lockClient);
          } catch {}

          await vaultLock.release();
        }
      },
      { scope: "worker" },
    ],
    _testContext: async (
      {
        _vaultLock,
        onTestFailed,
        task,
      }: Pick<BaseFixtureState & TestContext, "_vaultLock" | "onTestFailed" | "task">,
      use: (context: ObsidianTestContext) => Promise<void>,
    ) => {
      let failedTask = false;
      onTestFailed(() => {
        failedTask = true;
      });

      const context = await createInternalTestContext({
        ...options,
        createVault,
        testName: task.name,
        vaultLock: _vaultLock,
      });

      try {
        await use(context);
      } finally {
        await context.cleanup({
          failedTask: failedTask ? task : undefined,
        });
      }
    },
    // oxlint-disable-next-line no-empty-pattern
    obsidian: async (
      { _testContext }: Pick<BaseFixtureState, "_testContext">,
      use: (obsidian: ObsidianClient) => Promise<void>,
    ) => {
      await use(_testContext.obsidian);
    },
    sandbox: async (
      { _testContext }: Pick<BaseFixtureState, "_testContext">,
      use: (sandbox: ObsidianTestContext["sandbox"]) => Promise<void>,
    ) => {
      await use(_testContext.sandbox);
    },
    vault: async (
      { _testContext }: Pick<BaseFixtureState, "_testContext">,
      use: (vault: VaultApi) => Promise<void>,
    ) => {
      await use(_testContext.vault);
    },
  };
}
