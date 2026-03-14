import type {
  CreateObsidianClientOptions,
  ObsidianClient,
  SandboxApi,
  VaultApi,
} from "../core/types";

export interface CreateObsidianTestOptions extends CreateObsidianClientOptions {
  sandboxRoot?: string;
}

export interface ObsidianFixtures {
  obsidian: ObsidianClient;
  sandbox: SandboxApi;
  vault: VaultApi;
}
