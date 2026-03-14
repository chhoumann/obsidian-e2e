import { test as base } from "vite-plus/test";

import { createBaseFixtures } from "./base-fixtures";
import type { CreateObsidianTestOptions, ObsidianFixtures, ObsidianTest } from "./types";

export function createObsidianTest(options: CreateObsidianTestOptions): ObsidianTest {
  return base.extend<ObsidianFixtures>(createBaseFixtures(options));
}
