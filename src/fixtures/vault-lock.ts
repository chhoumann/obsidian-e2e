import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { ObsidianClient } from "../core/types";
import type { SharedVaultLockOptions } from "./types";

const DEFAULT_HEARTBEAT_MS = 2_000;
const DEFAULT_STALE_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_INTERVAL_MS = 500;
const DEFAULT_LOCK_ROOT = path.join(os.tmpdir(), "obsidian-e2e-locks");
const LOCK_METADATA_FILE = "lock.json";
const APP_LOCK_KEY = "__obsidianE2ELock";

export interface VaultRunLockMetadata {
  acquiredAt: number;
  cwd: string;
  heartbeatAt: number;
  hostname: string;
  ownerId: string;
  pid: number;
  staleMs: number;
  vaultName: string;
  vaultPath: string;
}

export interface VaultRunLock {
  readonly lockDir: string;
  readonly metadata: VaultRunLockMetadata;

  publishMarker(obsidian: ObsidianClient): Promise<void>;
  release(): Promise<void>;
}

interface AcquireVaultRunLockOptions extends SharedVaultLockOptions {
  vaultName: string;
  vaultPath: string;
}

export async function acquireVaultRunLock({
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  lockRoot = DEFAULT_LOCK_ROOT,
  onBusy = "wait",
  staleMs = DEFAULT_STALE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  vaultName,
  vaultPath,
}: AcquireVaultRunLockOptions): Promise<VaultRunLock> {
  const ownerId = randomUUID();
  const lockDir = path.join(lockRoot, createVaultLockKey(vaultPath));
  const metadataPath = path.join(lockDir, LOCK_METADATA_FILE);
  const metadata: VaultRunLockMetadata = {
    acquiredAt: Date.now(),
    cwd: process.cwd(),
    heartbeatAt: Date.now(),
    hostname: os.hostname(),
    ownerId,
    pid: process.pid,
    staleMs,
    vaultName,
    vaultPath,
  };

  await mkdir(lockRoot, { recursive: true });

  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDir);
      await writeMetadata(metadataPath, metadata);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const currentLock = await readLockState(lockDir);

      if (currentLock && !isLockStale(currentLock, staleMs)) {
        if (onBusy === "fail") {
          throw new Error(formatBusyLockMessage(vaultPath, currentLock));
        }
      } else {
        await rm(lockDir, { force: true, recursive: true });
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          currentLock
            ? `Timed out waiting for shared vault lock: ${formatBusyLockMessage(vaultPath, currentLock)}`
            : `Timed out waiting for shared vault lock on ${vaultPath}`,
        );
      }

      await sleep(Math.min(DEFAULT_WAIT_INTERVAL_MS, heartbeatMs));
    }
  }

  const heartbeat = setInterval(() => {
    metadata.heartbeatAt = Date.now();
    void writeMetadata(metadataPath, metadata).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();

  return {
    lockDir,
    metadata,
    async publishMarker(obsidian: ObsidianClient) {
      await obsidian.dev.eval(buildSetMarkerCode(metadata));
    },
    async release() {
      clearInterval(heartbeat);
      const currentLock = await readLockState(lockDir);

      if (currentLock?.ownerId !== metadata.ownerId) {
        return;
      }

      await rm(lockDir, { force: true, recursive: true });
    },
  };
}

export async function clearVaultRunLockMarker(obsidian: ObsidianClient): Promise<void> {
  await obsidian.dev.eval(`delete window.${APP_LOCK_KEY}; delete app.${APP_LOCK_KEY}; "cleared"`, {
    allowNonZeroExit: true,
  });
}

function createVaultLockKey(vaultPath: string): string {
  return createHash("sha256").update(path.resolve(vaultPath)).digest("hex");
}

function buildSetMarkerCode(metadata: VaultRunLockMetadata): string {
  const encodedMetadata = JSON.stringify(metadata);
  return `(() => {
    const lock = ${encodedMetadata};
    window.${APP_LOCK_KEY} = lock;
    app.${APP_LOCK_KEY} = lock;
    return lock;
  })()`;
}

async function readLockState(lockDir: string): Promise<VaultRunLockMetadata | null> {
  const metadataPath = path.join(lockDir, LOCK_METADATA_FILE);

  try {
    return JSON.parse(await readFile(metadataPath, "utf8")) as VaultRunLockMetadata;
  } catch {
    try {
      const directoryStat = await stat(lockDir);
      return {
        acquiredAt: directoryStat.mtimeMs,
        cwd: "",
        heartbeatAt: directoryStat.mtimeMs,
        hostname: "",
        ownerId: "",
        pid: 0,
        staleMs: DEFAULT_STALE_MS,
        vaultName: "",
        vaultPath: "",
      };
    } catch {
      return null;
    }
  }
}

function formatBusyLockMessage(vaultPath: string, metadata: VaultRunLockMetadata): string {
  const ownerDetails = metadata.ownerId
    ? `owner=${metadata.ownerId} pid=${metadata.pid} cwd=${metadata.cwd || "<unknown>"}`
    : "owner=<unknown>";

  return `vault ${vaultPath} is locked by ${ownerDetails}`;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isLockStale(metadata: VaultRunLockMetadata, staleMs: number): boolean {
  return Date.now() - metadata.heartbeatAt > staleMs;
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function writeMetadata(metadataPath: string, metadata: VaultRunLockMetadata): Promise<void> {
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}
