import { test as base } from "vite-plus/test";

import { createBaseFixtures, type BaseFixtureState } from "./base-fixtures";
import type { CreateObsidianTestOptions, ObsidianFixtures, ObsidianTest } from "./types";

export function createObsidianTest(options: CreateObsidianTestOptions): ObsidianTest {
  return base.extend<ObsidianFixtures & BaseFixtureState>(
    createBaseFixtures(options) as never,
  ) as ObsidianTest;
}
