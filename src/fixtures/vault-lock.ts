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
const heldLocks = new Map<string, HeldVaultRunLock>();

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

export interface VaultRunLockState {
  heartbeatAgeMs: number;
  isStale: boolean;
  lockDir: string;
  metadata: VaultRunLockMetadata;
}

interface AcquireVaultRunLockOptions extends SharedVaultLockOptions {
  vaultName: string;
  vaultPath: string;
}

interface HeldVaultRunLock {
  heartbeat: NodeJS.Timeout;
  lockDir: string;
  metadata: VaultRunLockMetadata;
  metadataPath: string;
  refs: number;
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
  const lockDir = path.join(lockRoot, createVaultLockKey(vaultPath));
  const heldLock = heldLocks.get(lockDir);

  if (heldLock) {
    heldLock.refs += 1;
    return createVaultRunLockHandle(heldLock);
  }

  const ownerId = randomUUID();
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

      const currentLock = await inspectVaultRunLock({
        lockRoot,
        staleMs,
        vaultPath,
      });

      if (currentLock && !currentLock.isStale) {
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

  const nextHeldLock: HeldVaultRunLock = {
    heartbeat,
    lockDir,
    metadata,
    metadataPath,
    refs: 1,
  };

  heldLocks.set(lockDir, nextHeldLock);
  return createVaultRunLockHandle(nextHeldLock);
}

export async function clearVaultRunLockMarker(obsidian: ObsidianClient): Promise<void> {
  await obsidian.dev.eval(`delete window.${APP_LOCK_KEY}; delete app.${APP_LOCK_KEY}; "cleared"`, {
    allowNonZeroExit: true,
  });
}

export async function inspectVaultRunLock({
  lockRoot = DEFAULT_LOCK_ROOT,
  staleMs = DEFAULT_STALE_MS,
  vaultPath,
}: Pick<
  AcquireVaultRunLockOptions,
  "lockRoot" | "staleMs" | "vaultPath"
>): Promise<VaultRunLockState | null> {
  const lockDir = path.join(lockRoot, createVaultLockKey(vaultPath));
  const metadata = await readLockState(lockDir);

  if (!metadata) {
    return null;
  }

  return {
    heartbeatAgeMs: Date.now() - metadata.heartbeatAt,
    isStale: isLockStale(metadata, staleMs),
    lockDir,
    metadata,
  };
}

export async function readVaultRunLockMarker(
  obsidian: ObsidianClient,
): Promise<VaultRunLockMetadata | null> {
  return obsidian.dev.eval<VaultRunLockMetadata | null>(
    `window.${APP_LOCK_KEY} ?? app.${APP_LOCK_KEY} ?? null`,
    { allowNonZeroExit: true },
  );
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

function createVaultRunLockHandle(heldLock: HeldVaultRunLock): VaultRunLock {
  return {
    get lockDir() {
      return heldLock.lockDir;
    },
    get metadata() {
      return heldLock.metadata;
    },
    async publishMarker(obsidian: ObsidianClient) {
      await obsidian.dev.eval(buildSetMarkerCode(heldLock.metadata));
    },
    async release() {
      if (heldLock.refs > 1) {
        heldLock.refs -= 1;
        return;
      }

      heldLocks.delete(heldLock.lockDir);
      clearInterval(heldLock.heartbeat);

      const currentLock = await readLockState(heldLock.lockDir);

      if (currentLock?.ownerId !== heldLock.metadata.ownerId) {
        return;
      }

      await rm(heldLock.lockDir, { force: true, recursive: true });
    },
  };
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

function formatBusyLockMessage(vaultPath: string, state: VaultRunLockState): string {
  const ownerDetails = state.metadata.ownerId
    ? `owner=${state.metadata.ownerId} pid=${state.metadata.pid} cwd=${state.metadata.cwd || "<unknown>"}`
    : "owner=<unknown>";
  const ageDetails = `heartbeatAgeMs=${state.heartbeatAgeMs} stale=${state.isStale}`;

  return `vault ${vaultPath} is locked by ${ownerDetails} ${ageDetails}`;
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
