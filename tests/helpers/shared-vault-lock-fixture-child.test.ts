import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test } from "vite-plus/test";

import { createObsidianTest } from "../../src/vitest";
import type { CommandTransport, ExecResult } from "../../src/core/types";

const isChildRun = process.env.OBSIDIAN_E2E_FIXTURE_CHILD === "1";

if (isChildRun) {
  await mkdir(getEnv("OBSIDIAN_E2E_SIGNAL_DIR"), { recursive: true });
  await writeJsonFile(getEnv("OBSIDIAN_E2E_STARTED_FILE"), {
    pid: process.pid,
    startedAt: Date.now(),
  });

  const childTest = createObsidianTest({
    sharedVaultLock: {
      heartbeatMs: 50,
      lockRoot: getEnv("OBSIDIAN_E2E_LOCK_ROOT"),
      staleMs: Number(process.env.OBSIDIAN_E2E_STALE_MS ?? "15_000"),
      timeoutMs: Number(process.env.OBSIDIAN_E2E_TIMEOUT_MS ?? "5_000"),
    },
    transport: createTransport(),
    vault: "dev",
  });

  childTest("acquires the shared vault lock through the fixture API", async ({ obsidian }) => {
    const vaultPath = await obsidian.vaultPath();
    expect(vaultPath).toBe(getEnv("OBSIDIAN_E2E_VAULT_ROOT"));

    await mkdir(getEnv("OBSIDIAN_E2E_SIGNAL_DIR"), { recursive: true });
    await writeJsonFile(getEnv("OBSIDIAN_E2E_READY_FILE"), {
      pid: process.pid,
      readyAt: Date.now(),
      vaultPath,
    });

    if (process.env.OBSIDIAN_E2E_CHILD_MODE === "hold") {
      await waitForFile(
        getEnv("OBSIDIAN_E2E_RELEASE_FILE"),
        Number(process.env.OBSIDIAN_E2E_TIMEOUT_MS ?? "5_000"),
      );
    }

    if (process.env.OBSIDIAN_E2E_CHILD_MODE === "crash") {
      process.kill(process.pid, "SIGKILL");
      return;
    }

    await writeJsonFile(getEnv("OBSIDIAN_E2E_DONE_FILE"), {
      doneAt: Date.now(),
      pid: process.pid,
    });
  });
} else {
  test.skip("shared vault lock fixture child helper", () => {});
}

function createTransport(): CommandTransport {
  let attemptedLockAcquisition = false;

  return async (request) => {
    if (request.argv[0] === "--help") {
      return createResult(request.bin, request.argv, "usage\n");
    }

    const [, command, ...rest] = request.argv;
    const args = Object.fromEntries(
      rest
        .filter((entry) => entry.includes("="))
        .map((entry) => {
          const [key, ...value] = entry.split("=");
          return [key, value.join("=")];
        }),
    );

    if (command === "vault" && args.info === "path") {
      if (!attemptedLockAcquisition) {
        attemptedLockAcquisition = true;
        await writeJsonFile(getEnv("OBSIDIAN_E2E_ATTEMPT_FILE"), {
          pid: process.pid,
          startedAt: Date.now(),
        });
      }
      return createResult(request.bin, request.argv, `${getEnv("OBSIDIAN_E2E_VAULT_ROOT")}\n`);
    }

    if (command === "vault" && args.info === "name") {
      return createResult(request.bin, request.argv, "dev\n");
    }

    if (command === "commands") {
      return createResult(request.bin, request.argv, "plugin:reload\n");
    }

    if (command === "eval") {
      const code = String(args.code ?? "");
      await appendFile(getEnv("OBSIDIAN_E2E_EVAL_LOG"), `${code}\n`, "utf8");
      return createResult(request.bin, request.argv, "{}\n");
    }

    throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
  };
}

function createResult(command: string, argv: string[], stdout: string): ExecResult {
  return {
    argv,
    command,
    exitCode: 0,
    stderr: "",
    stdout,
  };
}

function getEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    try {
      await access(filePath);
      return;
    } catch {}

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }

    await delay(50);
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
