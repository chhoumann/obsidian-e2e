export { createObsidianClient } from "./core/client";
export {
  acquireVaultRunLock,
  clearVaultRunLockMarker,
  inspectVaultRunLock,
  readVaultRunLockMarker,
} from "./fixtures/vault-lock";
export type {
  CommandListOptions,
  CommandTransport,
  CreateObsidianClientOptions,
  DevDomQueryOptions,
  DevDomResult,
  ExecOptions,
  ExecResult,
  JsonFile,
  JsonFileUpdater,
  ObsidianArg,
  ObsidianAppHandle,
  ObsidianClient,
  ObsidianCommandHandle,
  ObsidianDevHandle,
  OpenFileOptions,
  OpenTabOptions,
  PluginHandle,
  RestartAppOptions,
  SandboxApi,
  TabsOptions,
  VaultApi,
  WaitForOptions,
  WorkspaceNode,
  WorkspaceOptions,
  WorkspaceTab,
} from "./core/types";
export type {
  AcquireVaultRunLockOptions,
  VaultRunLock,
  VaultRunLockMetadata,
  VaultRunLockState,
} from "./fixtures/vault-lock";
export { createSandboxApi } from "./vault/sandbox";
export { createVaultApi } from "./vault/vault";
