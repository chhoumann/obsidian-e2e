export { createObsidianClient } from "./core/client";
export {
  captureFailureArtifacts,
  DEFAULT_FAILURE_ARTIFACTS_DIR,
  getFailureArtifactConfig,
  getFailureArtifactDirectory,
} from "./artifacts/failure-artifacts";
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
  PluginDataPredicate,
  PluginReloadOptions,
  RestartAppOptions,
  SandboxApi,
  TabsOptions,
  VaultApi,
  VaultContentPredicate,
  VaultWaitForContentOptions,
  VaultWriteOptions,
  WaitForOptions,
  WorkspaceNode,
  WorkspaceOptions,
  WorkspaceTab,
  PluginWaitForDataOptions,
  PluginWaitUntilReadyOptions,
} from "./core/types";
export type {
  CaptureFailureArtifactsOptions,
  FailureArtifactConfig,
  FailureArtifactOptions,
  FailureArtifactRegistrationOptions,
  FailureArtifactTask,
} from "./artifacts/failure-artifacts";
export type {
  AcquireVaultRunLockOptions,
  VaultRunLock,
  VaultRunLockMetadata,
  VaultRunLockState,
} from "./fixtures/vault-lock";
export { createSandboxApi } from "./vault/sandbox";
export { createVaultApi } from "./vault/vault";
