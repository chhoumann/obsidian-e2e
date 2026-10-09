import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ObsidianCommandError, ObsidianCommandTimeoutError } from "../../src/core/errors";
import { executeCommand } from "../../src/core/transport";
import { waitForValue } from "../../src/core/wait";
import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("executeCommand client ownership", () => {
  it("kills an in-flight client when Vitest stops the worker", { timeout: 60_000 }, async () => {
    const root = await createTempDir(tempDirectories, "obsidian-e2e-orphan-");
    const pidPath = path.join(root, "client.pid");

    const child = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/vite-plus/bin/vp"),
        "test",
        path.resolve("tests/helpers/orphan-client-child.test.ts"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OBSIDIAN_E2E_ORPHAN_CHILD: "1",
          OBSIDIAN_E2E_ORPHAN_PID_PATH: pidPath,
        },
      },
    );
    expect(child.status, child.stdout + child.stderr).toBe(0);

    const clientPid = Number(readFileSync(pidPath, "utf8"));

    try {
      await expect(
        waitForValue(() => !isAlive(clientPid), { intervalMs: 50, timeoutMs: 5_000 }),
      ).resolves.toBe(true);
    } finally {
      if (isAlive(clientPid)) {
        process.kill(clientPid, "SIGKILL");
      }
    }
  });
});

describe("executeCommand", () => {
  it("captures stdout from a completed command", async () => {
    const result = await executeCommand({
      argv: ["-e", "process.stdout.write('done')"],
      bin: process.execPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done");
  });

  it("throws ObsidianCommandError on nonzero exit with the captured result", async () => {
    const error = await executeCommand({
      argv: ["-e", "process.stderr.write('broken'); process.exit(3)"],
      bin: process.execPath,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ObsidianCommandError);
    expect((error as ObsidianCommandError).result.exitCode).toBe(3);
    expect((error as ObsidianCommandError).result.stderr).toBe("broken");
  });

  // Real child process and wall clock on purpose: this exercises the actual
  // spawn/kill timeout path; fake timers cannot advance a separate process.
  it("kills an overrunning command and rejects with ObsidianCommandTimeoutError", async () => {
    const error = await executeCommand({
      argv: ["-e", "setTimeout(() => {}, 60000)"],
      bin: process.execPath,
      timeoutMs: 150,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ObsidianCommandTimeoutError);
    expect((error as ObsidianCommandTimeoutError).bin).toBe(process.execPath);
    expect((error as ObsidianCommandTimeoutError).argv).toEqual([
      "-e",
      "setTimeout(() => {}, 60000)",
    ]);
    expect((error as ObsidianCommandTimeoutError).timeoutMs).toBe(150);
    expect((error as ObsidianCommandTimeoutError).message).toContain(
      "Command timed out after 150ms",
    );
  });
});
