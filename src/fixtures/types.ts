import type {
  CreateObsidianClientOptions,
  ObsidianClient,
  PluginHandle,
  PluginToggleOptions,
  SandboxApi,
  VaultApi,
} from "../core/types";
import type { TestAPI } from "vite-plus/test";

export interface CreateObsidianTestOptions extends CreateObsidianClientOptions {
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
