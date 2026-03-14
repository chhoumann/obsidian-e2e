import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, test } from "vite-plus/test";

const tempDirectories: string[] = [];
const childProcesses = new Set<ChildProcessByStdio<null, Readable, Readable>>();

afterEach(async () => {
  for (const child of childProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  childProcesses.clear();

  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("shared vault lock fixture integration", () => {
  test("serializes createObsidianTest runs across separate vp test processes", async () => {
    const sandbox = await createFixtureSandbox();
    const holder = await spawnFixtureChild({
      lockRoot: sandbox.lockRoot,
      mode: "hold",
      signalDir: path.join(sandbox.root, "holder"),
      vaultRoot: sandbox.vaultRoot,
    });

    const holderReady = await holder.waitForJson("ready.json");
    const waiter = await spawnFixtureChild({
      lockRoot: sandbox.lockRoot,
      mode: "once",
      signalDir: path.join(sandbox.root, "waiter"),
      vaultRoot: sandbox.vaultRoot,
    });

    await expect(waiter.waitForJson("ready.json", 250)).rejects.toThrow(/Timed out/);
    await holder.release();

    const waiterReady = await waiter.waitForJson("ready.json", 5_000);
    const holderDone = await holder.waitForJson("done.json");
    await waiter.waitForJson("done.json", 5_000);
    await expect(holder.exit).resolves.toMatchObject({ code: 0, signal: null });
    await expect(waiter.exit).resolves.toMatchObject({ code: 0, signal: null });
    childProcesses.delete(holder.child);
    childProcesses.delete(waiter.child);

    expect(waiterReady.readyAt).toBeGreaterThanOrEqual(
      holderDone.doneAt ?? holderReady.readyAt ?? 0,
    );
    await expect(readFile(holder.evalLog, "utf8")).resolves.toContain("__obsidianE2ELock");
    await expect(readFile(waiter.evalLog, "utf8")).resolves.toContain("__obsidianE2ELock");
  }, 10_000);

  test("waits for stale takeover when the fixture holder process crashes", async () => {
    const sandbox = await createFixtureSandbox();
    const staleMs = 150;
    const crashedHolder = await spawnFixtureChild({
      lockRoot: sandbox.lockRoot,
      mode: "crash",
      signalDir: path.join(sandbox.root, "holder"),
      staleMs,
      timeoutMs: 5_000,
      vaultRoot: sandbox.vaultRoot,
    });

    const holderReady = await crashedHolder.waitForJson("ready.json");
    await delay(100);

    const waiter = await spawnFixtureChild({
      lockRoot: sandbox.lockRoot,
      mode: "once",
      signalDir: path.join(sandbox.root, "waiter"),
      staleMs,
      timeoutMs: 5_000,
      vaultRoot: sandbox.vaultRoot,
    });
    const waiterReady = await waiter.waitForJson("ready.json", 3_000);
    await waiter.waitForJson("done.json");
    await expect(waiter.exit).resolves.toMatchObject({ code: 0, signal: null });
    childProcesses.delete(waiter.child);

    expect(waiterReady.readyAt).toBeGreaterThanOrEqual((holderReady.readyAt ?? 0) + staleMs);
  }, 10_000);
});

interface FixtureChildHandle {
  child: ChildProcessByStdio<null, Readable, Readable>;
  evalLog: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  release(): Promise<void>;
  waitForJson(fileName: string, timeoutMs?: number): Promise<FixtureChildSignal>;
}

interface FixtureChildSignal {
  doneAt?: number;
  pid: number;
  readyAt?: number;
  vaultPath?: string;
}

interface SpawnFixtureChildOptions {
  lockRoot: string;
  mode: "crash" | "hold" | "once";
  signalDir: string;
  staleMs?: number;
  timeoutMs?: number;
  vaultRoot: string;
}

async function createFixtureSandbox() {
  const root = await createTempDir("obsidian-e2e-fixture-lock-");
  const lockRoot = path.join(root, "locks");
  const vaultRoot = path.join(root, "vault");

  await mkdir(lockRoot, { recursive: true });
  await mkdir(vaultRoot, { recursive: true });

  return { lockRoot, root, vaultRoot };
}

async function spawnFixtureChild({
  lockRoot,
  mode,
  signalDir,
  staleMs = 15_000,
  timeoutMs = 5_000,
  vaultRoot,
}: SpawnFixtureChildOptions): Promise<FixtureChildHandle> {
  const readyFile = path.join(signalDir, "ready.json");
  const doneFile = path.join(signalDir, "done.json");
  const releaseFile = path.join(signalDir, "release.signal");
  const evalLog = path.join(signalDir, "eval.log");
  await mkdir(signalDir, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      path.resolve("node_modules/vite-plus/bin/vp"),
      "test",
      path.resolve("tests/helpers/shared-vault-lock-fixture-child.test.ts"),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OBSIDIAN_E2E_CHILD_MODE: mode,
        OBSIDIAN_E2E_EVAL_LOG: evalLog,
        OBSIDIAN_E2E_FIXTURE_CHILD: "1",
        OBSIDIAN_E2E_LOCK_ROOT: lockRoot,
        OBSIDIAN_E2E_READY_FILE: readyFile,
        OBSIDIAN_E2E_RELEASE_FILE: releaseFile,
        OBSIDIAN_E2E_SIGNAL_DIR: signalDir,
        OBSIDIAN_E2E_STALE_MS: String(staleMs),
        OBSIDIAN_E2E_TIMEOUT_MS: String(timeoutMs),
        OBSIDIAN_E2E_DONE_FILE: doneFile,
        OBSIDIAN_E2E_VAULT_ROOT: vaultRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  childProcesses.add(child);

  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    child,
    evalLog,
    exit,
    async release() {
      await writeFile(releaseFile, "release\n", "utf8");
    },
    async waitForJson(fileName, timeoutMs = 2_000) {
      const targetPath = path.join(signalDir, fileName);
      const startedAt = Date.now();

      while (true) {
        try {
          return JSON.parse(await readFile(targetPath, "utf8")) as FixtureChildSignal;
        } catch {}

        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `Child exited before writing ${targetPath}: code=${child.exitCode} signal=${child.signalCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          );
        }

        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(
            `Timed out waiting for ${targetPath}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          );
        }

        await delay(50);
      }
    },
  };
}

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}
