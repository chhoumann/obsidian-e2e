import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { acquireVaultRunLock, clearVaultRunLockMarker } from "../../src/fixtures/vault-lock";
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
    const heldLock = await acquireVaultRunLock({
      heartbeatMs: 10_000,
      lockRoot,
      onBusy: "wait",
      timeoutMs: 100,
      vaultName: "dev",
      vaultPath: "/tmp/dev-vault",
    });

    await expect(
      acquireVaultRunLock({
        lockRoot,
        onBusy: "fail",
        vaultName: "dev",
        vaultPath: "/tmp/dev-vault",
      }),
    ).rejects.toThrow(/is locked by/);

    await heldLock.release();
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
        return "ok";
      },
      vaultRoot: "/tmp/dev-vault",
    });

    await lock.publishMarker(obsidian);
    await clearVaultRunLockMarker(obsidian);

    expect(evalCalls[0]).toContain("window.__obsidianE2ELock = lock");
    expect(evalCalls[0]).toContain(lock.metadata.ownerId);
    expect(evalCalls[1]).toContain("delete window.__obsidianE2ELock");

    await lock.release();
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}
