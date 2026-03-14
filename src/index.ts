export { createObsidianClient } from "./core/client";
export type {
  CommandTransport,
  CreateObsidianClientOptions,
  ExecOptions,
  ExecResult,
  JsonFile,
  JsonFileUpdater,
  ObsidianArg,
  ObsidianClient,
  PluginHandle,
  SandboxApi,
  VaultApi,
  WaitForOptions,
} from "./core/types";
export { createSandboxApi } from "./vault/sandbox";
export { createVaultApi } from "./vault/vault";
