import { appendFileSync, mkdirSync } from "node:fs";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { captureOnTestFailure } from "../../src/fixtures/failure-artifacts";
import { createObsidianTest } from "../../src/vitest";
import { createExecResult, frameEvalPayload } from "./create-exec-result";

// Run by tests/fixtures/failure-timing.test.ts in a child `vp test`. Most of
// these tests fail on purpose; the parent asserts the event log they leave.
if (process.env.OBSIDIAN_E2E_TIMING_CHILD === "1") {
  const log = (event: string) => appendFileSync(getEnv("OBSIDIAN_E2E_TIMING_LOG"), `${event}\n`);

  describe("test body failures", () => {
    let retryAttempts = 0;

    beforeEach((ctx) => {
      captureOnTestFailure(ctx, async () => log(`capture:${ctx.task.name}`));
    });

    afterEach((ctx) => {
      log(`afterEach:${ctx.task.name}`);
    });

    test("throws", ({ onTestFinished }) => {
      onTestFinished(() => log("onTestFinished:throws"));
      throw new Error("boom");
    });

    test("soft", () => {
      expect.soft(1).toBe(2);
    });

    test("passes", () => {});

    test("passes on retry", { retry: 1 }, () => {
      retryAttempts += 1;

      if (retryAttempts === 1) {
        throw new Error("first attempt");
      }
    });
  });

  describe("afterEach failures", () => {
    beforeEach((ctx) => {
      captureOnTestFailure(ctx, async () => log(`capture:${ctx.task.name}`));
    });

    afterEach((ctx) => {
      log(`afterEach:${ctx.task.name}`);
      throw new Error("cleanup failed");
    });

    test("cleanup throws", () => {});
  });

  const fixtureTest = createObsidianTest({
    artifactsDir: getEnv("OBSIDIAN_E2E_TIMING_ARTIFACTS"),
    captureOnFailure: { screenshot: false },
    transport: async (request) => {
      const [, command, ...rest] = request.argv;

      if (request.argv[0] === "--help") {
        return createExecResult(request.bin, request.argv, "usage\n");
      }

      if (command === "vault" && rest.includes("info=path")) {
        const vaultRoot = getEnv("OBSIDIAN_E2E_TIMING_VAULT");
        mkdirSync(vaultRoot, { recursive: true });
        return createExecResult(request.bin, request.argv, `${vaultRoot}\n`);
      }

      if (command === "eval") {
        const code = rest.find((entry) => entry.startsWith("code="))?.slice("code=".length) ?? "";
        return createExecResult(
          request.bin,
          request.argv,
          `${frameEvalPayload(code, '{"ok":true,"value":null}')}\n`,
        );
      }

      return createExecResult(request.bin, request.argv, "[]\n");
    },
    vault: "dev",
  });

  fixtureTest("fixture api fails", ({ obsidian }) => {
    expect(obsidian.vaultName).toBe("elsewhere");
  });
} else {
  test.skip("failure timing child helper", () => {});
}

function getEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}
