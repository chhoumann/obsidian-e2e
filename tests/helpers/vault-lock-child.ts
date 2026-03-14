import process from "node:process";
import { once } from "node:events";

const vaultLockModulePath = new URL("../../src/fixtures/vault-lock.ts", import.meta.url);
const { acquireVaultRunLock } = await import(vaultLockModulePath.href);

type VaultLockChildMode = "acquire-and-release" | "crash-after-acquire" | "hold";

const [, , modeArg, lockRoot, vaultPath, staleMsArg] = process.argv;

const mode = modeArg as VaultLockChildMode | undefined;

if (!mode || !lockRoot || !vaultPath) {
  await writeEvent({
    message: "Usage: vault-lock-child.ts <mode> <lockRoot> <vaultPath> [staleMs]",
    type: "error",
  });
  process.exitCode = 1;
} else {
  try {
    const staleMs = staleMsArg ? Number(staleMsArg) : undefined;
    await writeEvent({
      pid: process.pid,
      startedAt: Date.now(),
      type: "attempting",
    });
    const lock = await acquireVaultRunLock({
      heartbeatMs: 50,
      lockRoot,
      onBusy: "wait",
      staleMs,
      timeoutMs: 5_000,
      vaultName: "dev",
      vaultPath,
    });

    await writeEvent({
      acquiredAt: Date.now(),
      ownerId: lock.metadata.ownerId,
      pid: process.pid,
      type: "acquired",
    });

    if (mode === "crash-after-acquire") {
      process.exit(0);
    }

    if (mode === "hold") {
      process.stdin.resume();
      await Promise.race([once(process.stdin, "data"), once(process.stdin, "end")]);
    }

    await lock.release();
    await writeEvent({
      releasedAt: Date.now(),
      type: "released",
    });
  } catch (error) {
    await writeEvent({
      message: error instanceof Error ? error.message : String(error),
      type: "error",
    });
    process.exitCode = 1;
  }
}

interface VaultLockChildEvent {
  acquiredAt?: number;
  message?: string;
  ownerId?: string;
  pid?: number;
  releasedAt?: number;
  startedAt?: number;
  type: "acquired" | "attempting" | "error" | "released";
}

async function writeEvent(event: VaultLockChildEvent): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
