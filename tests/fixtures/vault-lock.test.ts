import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  acquireVaultRunLock,
  clearVaultRunLockMarker,
  inspectVaultRunLock,
  readVaultRunLockMarker,
} from "../../src/fixtures/vault-lock";
import { createStubObsidianClient } from "../helpers/stub-obsidian-client";

const tempDirectories: string[] = [];
const childProcesses = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of childProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  childProcesses.clear();
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("vault lock", () => {
  test("acquires and releases a shared vault lock", async () => {
    const lockRoot = await createTempDir("obsidian-e2e-locks-");
    const lock = await acquireVaultRunLock({
      heartbeatMs: 10_000,
      lockRoot,
      vaultName: "dev",
      vaultPath: "/tmp/dev-vault",
    });

    await expect(fs.access(lock.lockDir)).resolves.toBeUndefined();

    await lock.release();

    await expect(fs.access(lock.lockDir)).rejects.toThrow();
  });

  test("fails fast when the shared vault lock is already held", async () => {
    const lockRoot = await createTempDir("obsidian-e2e-locks-");
    const vaultPath = "/tmp/dev-vault";
    const lockDir = path.join(
      lockRoot,
      createHash("sha256").update(path.resolve(vaultPath)).digest("hex"),
    );
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "lock.json"),
      `${JSON.stringify(
        {
          acquiredAt: Date.now(),
          cwd: "/tmp/other-run",
          heartbeatAt: Date.now(),
          hostname: "other-host",
          ownerId: "other-owner",
          pid: 12345,
          staleMs: 15_000,
          vaultName: "dev",
          vaultPath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      acquireVaultRunLock({
        lockRoot,
        onBusy: "fail",
        vaultName: "dev",
        vaultPath,
      }),
    ).rejects.toThrow(/other-owner/);
  });

  test("reuses the same shared vault lock within one process", async () => {
    const lockRoot = await createTempDir("obsidian-e2e-locks-");
    const firstLock = await acquireVaultRunLock({
      heartbeatMs: 10_000,
      lockRoot,
      onBusy: "fail",
      vaultName: "dev",
      vaultPath: "/tmp/dev-vault",
    });
    const secondLock = await acquireVaultRunLock({
      heartbeatMs: 10_000,
      lockRoot,
      onBusy: "fail",
      vaultName: "dev",
      vaultPath: "/tmp/dev-vault",
    });

    expect(secondLock.metadata.ownerId).toBe(firstLock.metadata.ownerId);

    await firstLock.release();
    await expect(fs.access(firstLock.lockDir)).resolves.toBeUndefined();

    await secondLock.release();
    await expect(fs.access(firstLock.lockDir)).rejects.toThrow();
  });

  test("steals a stale shared vault lock", async () => {
    const lockRoot = await createTempDir("obsidian-e2e-locks-");
    const staleVaultPath = "/tmp/stale-vault";
    const staleLockDir = path.join(
      lockRoot,
      createHash("sha256").update(path.resolve(staleVaultPath)).digest("hex"),
    );
    await fs.mkdir(staleLockDir, { recursive: true });
    await fs.writeFile(
      path.join(staleLockDir, "lock.json"),
      `${JSON.stringify(
        {
          acquiredAt: Date.now() - 60_000,
          cwd: "/tmp/stale",
          heartbeatAt: Date.now() - 60_000,
          hostname: "stale-host",
          ownerId: "stale-owner",
          pid: 1,
          staleMs: 1_000,
          vaultName: "dev",
          vaultPath: staleVaultPath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const lock = await acquireVaultRunLock({
      heartbeatMs: 10_000,
      lockRoot,
      staleMs: 50,
      vaultName: "dev",
      vaultPath: staleVaultPath,
    });

    expect(lock.metadata.ownerId).not.toBe("stale-owner");
    await lock.release();
  });

  test("publishes and clears the app marker through dev eval", async () => {
    const evalCalls: string[] = [];
    let currentMarker: unknown = null;
    const lockRoot = await createTempDir("obsidian-e2e-locks-");
    const lock = await acquireVaultRunLock({
      heartbeatMs: 10_000,
      lockRoot,
      vaultName: "dev",
      vaultPath: "/tmp/dev-vault",
    });
    const obsidian = createStubObsidianClient({
      onEval(code) {
        evalCalls.push(code);
        if (code.includes("window.__obsidianE2ELock = lock")) {
          currentMarker = lock.metadata;
          return lock.metadata;
        }

        if (code.includes("delete window.__obsidianE2ELock")) {
          currentMarker = null;
          return "cleared";
        }

        if (code === "window.__obsidianE2ELock ?? app.__obsidianE2ELock ?? null") {
          return currentMarker;
        }

        return "ok";
      },
      vaultRoot: "/tmp/dev-vault",
    });

    await lock.publishMarker(obsidian);
    await expect(readVaultRunLockMarker(obsidian)).resolves.toEqual(lock.metadata);
    await clearVaultRunLockMarker(obsidian);
    await expect(readVaultRunLockMarker(obsidian)).resolves.toBeNull();

    expect(evalCalls[0]).toContain("window.__obsidianE2ELock = lock");
    expect(evalCalls[0]).toContain(lock.metadata.ownerId);
    expect(evalCalls[1]).toContain("window.__obsidianE2ELock ?? app.__obsidianE2ELock ?? null");
    expect(evalCalls[2]).toContain("delete window.__obsidianE2ELock");
    expect(evalCalls[3]).toContain("window.__obsidianE2ELock ?? app.__obsidianE2ELock ?? null");

    await lock.release();
  });

  test("inspects the current filesystem lock state", async () => {
    const lockRoot = await createTempDir("obsidian-e2e-locks-");
    const vaultPath = "/tmp/dev-vault";
    const lock = await acquireVaultRunLock({
      heartbeatMs: 10_000,
      lockRoot,
      vaultName: "dev",
      vaultPath,
    });

    await expect(
      inspectVaultRunLock({
        lockRoot,
        staleMs: 60_000,
        vaultPath,
      }),
    ).resolves.toMatchObject({
      isStale: false,
      lockDir: lock.lockDir,
      metadata: {
        ownerId: lock.metadata.ownerId,
        vaultPath,
      },
    });

    await lock.release();
    await expect(inspectVaultRunLock({ lockRoot, vaultPath })).resolves.toBeNull();
  });

  test("serializes lock acquisition across separate processes", async () => {
    const lockRoot = await createTempDir("obsidian-e2e-locks-");
    const vaultPath = "/tmp/dev-vault";
    const holder = spawnVaultLockChild("hold", lockRoot, vaultPath);
    await holder.nextEvent("attempting");
    const holderAcquired = await holder.nextEvent("acquired");
    await expectLockState(lockRoot, vaultPath, (state) => {
      expect(state).not.toBeNull();
      expect(state?.isStale).toBe(false);
      expect(state?.metadata.ownerId).toBe(holderAcquired.ownerId);
    });

    const waiter = spawnVaultLockChild("acquire-and-release", lockRoot, vaultPath);
    await waiter.nextEvent("attempting");
    await expectLockState(lockRoot, vaultPath, (state) => {
      expect(state).not.toBeNull();
      expect(state?.isStale).toBe(false);
      expect(state?.metadata.ownerId).toBe(holderAcquired.ownerId);
    });

    holder.release();
    const holderReleased = await holder.nextEvent("released");
    const waiterAcquired = await waiter.nextEvent("acquired", 5_000);
    await expectLockState(lockRoot, vaultPath, (state) => {
      expect(state).not.toBeNull();
      expect(state?.isStale).toBe(false);
      expect(state?.metadata.ownerId).toBe(waiterAcquired.ownerId);
    });

    const waiterReleased = await waiter.nextEvent("released", 5_000);

    expect(waiterAcquired.ownerId).not.toBe(holderAcquired.ownerId);
    expect(waiterAcquired.acquiredAt).toBeGreaterThanOrEqual(holderReleased.releasedAt ?? 0);
    expect(waiterReleased.releasedAt).toBeGreaterThanOrEqual(waiterAcquired.acquiredAt ?? 0);

    await expect(holder.exit).resolves.toMatchObject({ code: 0, signal: null });
    await expect(waiter.exit).resolves.toMatchObject({ code: 0, signal: null });
    childProcesses.delete(holder.child);
    childProcesses.delete(waiter.child);
  });

  test("allows another process to take over a stale lock after the holder exits", async () => {
    const lockRoot = await createTempDir("obsidian-e2e-locks-");
    const vaultPath = "/tmp/dev-vault";
    const staleMs = 150;
    const crashedHolder = spawnVaultLockChild("crash-after-acquire", lockRoot, vaultPath, staleMs);
    await crashedHolder.nextEvent("attempting");
    const crashedAcquired = await crashedHolder.nextEvent("acquired");
    await expectLockState(lockRoot, vaultPath, (state) => {
      expect(state).not.toBeNull();
      expect(state?.isStale).toBe(false);
      expect(state?.metadata.ownerId).toBe(crashedAcquired.ownerId);
    });

    await expect(crashedHolder.exit).resolves.toMatchObject({ code: 0, signal: null });
    childProcesses.delete(crashedHolder.child);
    await expectLockState(
      lockRoot,
      vaultPath,
      (state) => {
        expect(state).not.toBeNull();
        expect(state?.isStale).toBe(true);
        expect(state?.metadata.ownerId).toBe(crashedAcquired.ownerId);
      },
      5_000,
      staleMs,
    );

    const waiter = spawnVaultLockChild("acquire-and-release", lockRoot, vaultPath, staleMs);
    await waiter.nextEvent("attempting");
    const waiterAcquired = await waiter.nextEvent("acquired", 3_000);
    await expectLockState(lockRoot, vaultPath, (state) => {
      expect(state).not.toBeNull();
      expect(state?.isStale).toBe(false);
      expect(state?.metadata.ownerId).toBe(waiterAcquired.ownerId);
    });
    const waiterReleased = await waiter.nextEvent("released");
    expect(crashedAcquired.acquiredAt).toBeTypeOf("number");
    const crashedAcquiredAt = crashedAcquired.acquiredAt ?? 0;

    expect(waiterAcquired.ownerId).not.toBe(crashedAcquired.ownerId);
    expect(waiterAcquired.acquiredAt).toBeGreaterThanOrEqual(crashedAcquiredAt + staleMs);
    expect(waiterReleased.releasedAt).toBeGreaterThanOrEqual(waiterAcquired.acquiredAt ?? 0);
    await expect(waiter.exit).resolves.toMatchObject({ code: 0, signal: null });
    childProcesses.delete(waiter.child);
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

type VaultLockChildMode = "acquire-and-release" | "crash-after-acquire" | "hold";

interface VaultLockChildEvent {
  acquiredAt?: number;
  message?: string;
  ownerId?: string;
  pid?: number;
  releasedAt?: number;
  startedAt?: number;
  type: "acquired" | "attempting" | "error" | "released";
}

interface VaultLockChildHandle {
  child: ChildProcessWithoutNullStreams;
  events: VaultLockChildEvent[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  nextEvent(type: VaultLockChildEvent["type"], timeoutMs?: number): Promise<VaultLockChildEvent>;
  release(): void;
}

function spawnVaultLockChild(
  mode: VaultLockChildMode,
  lockRoot: string,
  vaultPath: string,
  staleMs?: number,
): VaultLockChildHandle {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      path.resolve("tests/helpers/vault-lock-child.ts"),
      mode,
      lockRoot,
      vaultPath,
      ...(staleMs ? [String(staleMs)] : []),
    ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  childProcesses.add(child);

  const events: VaultLockChildEvent[] = [];
  const pendingResolvers = new Set<() => void>();
  const stdout = createInterface({ input: child.stdout });
  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let stderr = "";

  stdout.on("line", (line) => {
    const event = JSON.parse(line) as VaultLockChildEvent;
    events.push(event);

    for (const resolve of pendingResolvers) {
      resolve();
    }
    pendingResolvers.clear();
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      stdout.close();
      exitResult = { code, signal };

      for (const notify of pendingResolvers) {
        notify();
      }
      pendingResolvers.clear();
      resolve(exitResult);
    });
  });

  async function nextEvent(
    type: VaultLockChildEvent["type"],
    timeoutMs = 2_000,
  ): Promise<VaultLockChildEvent> {
    const startedAt = Date.now();

    while (true) {
      const index = events.findIndex((event) => event.type === type || event.type === "error");

      if (index >= 0) {
        const event = events.splice(index, 1).at(0);

        if (!event) {
          continue;
        }

        if (event.type === "error") {
          throw new Error(
            `Child lock worker failed: ${event.message ?? "Unknown error"}\n${stderr}`,
          );
        }

        return event;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for child ${type} event.\nstdout events: ${JSON.stringify(events)}\nstderr: ${stderr}`,
        );
      }

      if (exitResult) {
        throw new Error(
          `Child exited before ${type} event: code=${exitResult.code} signal=${exitResult.signal}\nstdout events: ${JSON.stringify(events)}\nstderr: ${stderr}`,
        );
      }

      await new Promise<void>((resolve) => {
        const wake = () => {
          pendingResolvers.delete(wake);
          resolve();
        };

        pendingResolvers.add(wake);
        const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
        setTimeout(
          () => {
            pendingResolvers.delete(wake);
            resolve();
          },
          Math.min(remainingMs, 100),
        );
      });
    }
  }

  return {
    child,
    events,
    exit,
    nextEvent,
    release() {
      child.stdin.write("release\n");
      child.stdin.end();
    },
  };
}

async function expectLockState(
  lockRoot: string,
  vaultPath: string,
  assertState: (state: Awaited<ReturnType<typeof inspectVaultRunLock>>) => void,
  timeoutMs = 2_000,
  staleMs?: number,
): Promise<void> {
  const startedAt = Date.now();
  let lastState: Awaited<ReturnType<typeof inspectVaultRunLock>> = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastState = await inspectVaultRunLock({
      lockRoot,
      staleMs,
      vaultPath,
    });

    try {
      assertState(lastState);
      return;
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assertState(lastState);
}
