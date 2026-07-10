/**
 * Programmatic entry point for the worktree-isolated Obsidian instance runner,
 * exposed as `obsidian-e2e/runner`. The bin (`obsidian-e2e`) is a thin shell over
 * these same functions; consumers who need to orchestrate instances from their own
 * scripts import from here instead of shelling out.
 */

export { CONFIG_FILE_NAME, loadRunnerConfig, resolveRunnerConfig } from "./config";
export {
  DEFAULT_ROOT,
  linkPluginFile,
  provisionShellExports,
  provisionVault,
  resolveProvisionOptions,
} from "./provision";
export {
  INSTANCE_MARKER_FILE,
  linkHostKeychains,
  prepareObsidianProfile,
  readInstanceMarker,
  resolveInstanceOptions,
  stableInstanceId,
  stableVaultId,
  stampInstanceMarkerAppVersion,
  toInstanceShellExports,
  writeInstanceMarker,
} from "./instance";
export type {
  InstanceShellExportInput,
  PrepareProfileOptions,
  PrepareProfileResult,
} from "./instance";
export {
  assertObsidianMeetsMinAppVersion,
  bundledAsarCandidates,
  compareObsidianVersions,
  macObsidianConfigDir,
  readAsarPackageVersion,
  reconcileSandboxAppAsar,
  resolveObsidianAppVersion,
} from "./version-guard";
export type {
  CachedAsar,
  MinAppVersionOptions,
  MinAppVersionResult,
  ResolveAppVersionOptions,
  ResolvedAppVersion,
} from "./version-guard";
export {
  cliSocketExists,
  cliSocketPath,
  execObsidian,
  isInstanceReady,
  launchObsidianInstance,
  reloadPlugin,
  trustVaultAndVerifyPlugin,
  waitForInstanceReady,
} from "./launch";
export type {
  ExecFileFn,
  ExecFileResult,
  ExecFileRunOptions,
  InstanceReadyTarget,
  LaunchTarget,
  ObsidianExecDependencies,
  ObsidianExecTarget,
  VaultExecTarget,
} from "./launch";
export {
  collectInstancePids,
  commandMatchesInstance,
  INSTANCE_DIR_PATTERN,
  isInstanceOrphaned,
  parsePsOutput,
  reapOrphanedInstances,
  readInstanceVaultPaths,
  stopInstance,
  TERM_GRACE_MS,
  TERM_POLL_MS,
} from "./stop";
export type { ReapInstancesOptions } from "./stop";
export {
  assertOwnedDir,
  assertSecureDirIfPresent,
  ensureSecureDir,
  resolveCurrentUid,
} from "./security";
export type { SecureDirOptions } from "./security";
export { ensureObsidianInstance } from "./ensure";
export type { EnsureDependencies, EnsureResult } from "./ensure";
export { obsidianCommandArgs, obsidianEnv, runObsidianE2ECli, spawnObsidian } from "./cli";
export type { ChildProcessLike, CliDependencies, SpawnFn } from "./cli";
export { createArgsParser, parseArgs, SHARED_BOOLEAN_OPTIONS, SHARED_VALUE_OPTIONS } from "./args";
export type { ArgsParserSpec, ParsedArgs } from "./args";
export {
  pathExists,
  safeName,
  shellQuote,
  slugify,
  toShellExports,
  writeJson,
  writeJsonIfMissing,
} from "./fs-utils";
export type { ShellExport, WriteJsonOptions } from "./fs-utils";
export type {
  CollectInstanceOptions,
  InstanceMarker,
  InstanceOptions,
  InstanceRawOptions,
  ProcessInfo,
  ProfileResult,
  ProvisionOptions,
  ProvisionRawOptions,
  ProvisionResult,
  ReadyProbe,
  ReapOptions,
  ReapResult,
  ResolvedRunnerConfig,
  RunnerConfig,
  StopOptions,
  StopResult,
} from "./types";
