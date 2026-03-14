import { describe, expect, expectTypeOf, test } from "vite-plus/test";

import {
  acquireVaultRunLock,
  clearVaultRunLockMarker,
  inspectVaultRunLock,
  readVaultRunLockMarker,
} from "../../src/index";
import type {
  AcquireVaultRunLockOptions,
  VaultRunLock,
  VaultRunLockMetadata,
  VaultRunLockState,
} from "../../src/index";

describe("main entry vault lock exports", () => {
  test("exposes vault lock runtime helpers from the main barrel", () => {
    expect(acquireVaultRunLock).toBeTypeOf("function");
    expect(clearVaultRunLockMarker).toBeTypeOf("function");
    expect(inspectVaultRunLock).toBeTypeOf("function");
    expect(readVaultRunLockMarker).toBeTypeOf("function");
  });

  test("keeps lock-related type exports available from the main barrel", () => {
    expectTypeOf<AcquireVaultRunLockOptions>().toMatchTypeOf<{
      lockRoot?: string;
      onBusy?: "fail" | "wait";
      staleMs?: number;
      timeoutMs?: number;
      vaultName: string;
      vaultPath: string;
    }>();

    expectTypeOf<VaultRunLockMetadata>().toMatchTypeOf<{
      ownerId: string;
      vaultName: string;
      vaultPath: string;
    }>();

    expectTypeOf<VaultRunLockState>().toMatchTypeOf<{
      heartbeatAgeMs: number;
      isStale: boolean;
      metadata: VaultRunLockMetadata;
    }>();

    expectTypeOf<VaultRunLock["lockDir"]>().toEqualTypeOf<string>();
    expectTypeOf<VaultRunLock["metadata"]>().toEqualTypeOf<VaultRunLockMetadata>();
    expectTypeOf<VaultRunLock["publishMarker"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<VaultRunLock["release"]>().returns.toEqualTypeOf<Promise<void>>();
  });
});
