import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  acquireVaultRunLock,
  clearVaultRunLockMarker,
  inspectVaultRunLock,
  readVaultRunLockMarker,
} from "../../src/fixtures/vault-lock";
import { createStubObsidianClient } from "../helpers/stub-obsidian-client";

const tempDirectories: string[] = [];

afterEach(async () => {
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
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}
