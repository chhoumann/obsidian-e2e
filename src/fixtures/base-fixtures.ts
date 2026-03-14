import type { TestContext } from "vite-plus/test";

import { createObsidianClient } from "../core/client";
import { getClientInternals } from "../core/internals";
import type { ObsidianClient, VaultApi } from "../core/types";
import { createSandboxApi } from "../vault/sandbox";
import { createVaultApi } from "../vault/vault";
import { registerFailureArtifacts } from "./failure-artifacts";
import type { CreateObsidianTestOptions } from "./types";

export const DEFAULT_SANDBOX_ROOT = "__obsidian_e2e__";

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
    // oxlint-disable-next-line no-empty-pattern
    obsidian: async (
      { onTestFailed, task }: Pick<TestContext, "onTestFailed" | "task">,
      use: (obsidian: ObsidianClient) => Promise<void>,
    ) => {
      const obsidian = createObsidianClient(options);

      await obsidian.verify();
      registerFailureArtifacts({ onTestFailed, task }, obsidian, options);

      try {
        await use(obsidian);
      } finally {
        await getClientInternals(obsidian).restoreAll();
      }
    },
    sandbox: async (
      { obsidian }: { obsidian: ObsidianClient },
      use: (sandbox: Awaited<ReturnType<typeof createSandboxApi>>) => Promise<void>,
    ) => {
      const sandbox = await createSandboxApi({
        obsidian,
        sandboxRoot: options.sandboxRoot ?? DEFAULT_SANDBOX_ROOT,
        testName: "test",
      });

      try {
        await use(sandbox);
      } finally {
        await sandbox.cleanup();
      }
    },
    vault: async (
      { obsidian }: { obsidian: ObsidianClient },
      use: (vault: VaultApi) => Promise<void>,
    ) => {
      await use(await createVault(obsidian));
    },
  };
}
