import type {
  CreateObsidianClientOptions,
  ObsidianClient,
  PluginHandle,
  PluginToggleOptions,
  SandboxApi,
  VaultApi,
} from "../core/types";
import type { TestAPI } from "vite-plus/test";

export interface FailureArtifactOptions {
  activeFile?: boolean;
  dom?: boolean;
  editorText?: boolean;
  screenshot?: boolean;
  tabs?: boolean;
  workspace?: boolean;
}

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

export type VaultSeedEntry = string | { json: unknown };

export type VaultSeed = Record<string, VaultSeedEntry>;

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
