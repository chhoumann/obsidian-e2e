import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { afterEach, expect, test } from "vite-plus/test";

import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

// Vitest runs afterEach hooks, fixture teardown and onTestFinished before
// onTestFailed. Run real failing tests in a child `vp test` and check that
// failure capture sees the state before any of that cleanup.
test("captures failures before the test's own cleanup runs", { timeout: 60_000 }, async () => {
  const root = await createTempDir(tempDirectories, "obsidian-e2e-failure-timing-");
  const logPath = path.join(root, "events.log");
  const artifactsDir = path.join(root, "artifacts");

  const child = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/vite-plus/bin/vp"),
      "test",
      path.resolve("tests/helpers/failure-timing-child.test.ts"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OBSIDIAN_E2E_TIMING_ARTIFACTS: artifactsDir,
        OBSIDIAN_E2E_TIMING_CHILD: "1",
        OBSIDIAN_E2E_TIMING_LOG: logPath,
        OBSIDIAN_E2E_TIMING_VAULT: path.join(root, "vault"),
      },
    },
  );

  expect(child.status, child.stdout + child.stderr).toBe(1);
  expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
    "capture:throws",
    "afterEach:throws",
    "onTestFinished:throws",
    "capture:soft",
    "afterEach:soft",
    "afterEach:passes",
    "capture:passes on retry",
    "afterEach:passes on retry",
    "afterEach:passes on retry",
    "afterEach:cleanup throws",
    "capture:cleanup throws",
  ]);
  expect(readdirSync(artifactsDir)).toEqual([expect.stringMatching(/^fixture-api-fails-/u)]);
});
