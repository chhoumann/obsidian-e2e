import type { FailureArtifactOptions, FailureArtifactTask } from "../artifacts/failure-artifacts";
import type {
  CreateObsidianClientOptions,
  NoteInput,
  ObsidianClient,
  PluginHandle,
  PluginToggleOptions,
  SandboxApi,
  VaultApi,
} from "../core/types";
import type { TestAPI } from "vite-plus/test";

export interface SharedVaultLockOptions {
  heartbeatMs?: number;
  lockRoot?: string;
  onBusy?: "fail" | "wait";
  staleMs?: number;
  timeoutMs?: number;
}

export interface CreateObsidianTestOptions extends CreateObsidianClientOptions {
  artifactsDir?: string;
  captureOnFailure?: boolean | FailureArtifactOptions;
  sharedVaultLock?: boolean | SharedVaultLockOptions;
  sandboxRoot?: string;
}

export type VaultSeedEntry = string | { json: unknown } | { note: NoteInput };

export type VaultSeed = Record<string, VaultSeedEntry>;

export interface PluginSessionOptions {
  filter?: PluginToggleOptions["filter"];
  seedData?: unknown;
}

export interface TestContextCleanupOptions {
  failedTask?: FailureArtifactTask;
}

export interface TestContext {
  obsidian: ObsidianClient;
  sandbox: SandboxApi;
  vault: VaultApi;

  captureFailureArtifacts(task: FailureArtifactTask): Promise<string | undefined>;
  cleanup(options?: TestContextCleanupOptions): Promise<void>;
  plugin(id: string, options?: PluginSessionOptions): Promise<PluginHandle>;
  resetDiagnostics(): Promise<void>;
}

export interface CreatePluginTestOptions extends CreateObsidianTestOptions {
  pluginFilter?: PluginToggleOptions["filter"];
  pluginId: string;
  seedPluginData?: unknown;
  seedVault?: VaultSeed;
}

export interface ObsidianFixtures {
  obsidian: ObsidianClient;
  sandbox: SandboxApi;
  vault: VaultApi;
}

export interface PluginFixtures extends ObsidianFixtures {
  plugin: PluginHandle;
}

export type ObsidianTest = TestAPI<ObsidianFixtures>;

export type PluginTest = TestAPI<PluginFixtures>;
