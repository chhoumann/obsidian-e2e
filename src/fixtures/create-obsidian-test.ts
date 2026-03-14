import { test as base } from "vite-plus/test";

import { createObsidianClient } from "../core/client";
import { getClientInternals } from "../core/internals";
import { createSandboxApi } from "../vault/sandbox";
import { createVaultApi } from "../vault/vault";
import type { CreateObsidianTestOptions, ObsidianFixtures } from "./types";

const DEFAULT_SANDBOX_ROOT = "__obsidian_e2e__";

export function createObsidianTest(options: CreateObsidianTestOptions) {
  return base.extend<ObsidianFixtures>({
    // oxlint-disable-next-line no-empty-pattern
    obsidian: async ({}, use) => {
      const obsidian = createObsidianClient(options);

      await obsidian.verify();

      try {
        await use(obsidian);
      } finally {
        await getClientInternals(obsidian).restoreAll();
      }
    },
    sandbox: async ({ obsidian }, use) => {
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
    vault: async ({ obsidian }, use) => {
      await use(createVaultApi({ obsidian }));
    },
  });
}
