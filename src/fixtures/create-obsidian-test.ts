// Bind to "vitest" (not "vite-plus/test"), mirroring plugin-harness.ts: the
// returned `test` object registers fixtures on the runner instance it was
// created from, which must be the consumer's own vitest. Inside this package
// "vitest" is pinned to the copy vite-plus/test re-exports, so the package's own
// suite stays consistent while dist externalizes "vitest".
import { test as base } from "vitest";

import { createBaseFixtures, type BaseFixtureState } from "./base-fixtures";
import type { CreateObsidianTestOptions, ObsidianFixtures, ObsidianTest } from "./types";

export function createObsidianTest(options: CreateObsidianTestOptions): ObsidianTest {
  return base.extend<ObsidianFixtures & BaseFixtureState>(
    createBaseFixtures(options) as never,
  ) as ObsidianTest;
}
