import type { Dirent } from "node:fs";

/**
 * How the launcher confirms a plugin is live in the target vault. The `match`
 * string is what the probe output must contain to count as ready; the `code` /
 * `args` intentionally never embed that match string, so an echoed command can
 * never be mistaken for a positive result.
 */
export type ReadyProbe =
  | { kind: "eval"; code: string; match: string }
  | { kind: "command"; args: string[]; match: string };

/**
 * Per-repo runner config, authored as `obsidian-e2e.config.mjs` at the worktree
 * root. Only `pluginId` is required; every other field has a default applied by
 * {@link loadRunnerConfig}.
 */
export interface RunnerConfig {
  pluginId: string;
  vaultPrefix?: string;
  pluginArtifacts?: string[];
  defaultData?: unknown;
  buildCommand?: string;
  defaultCommand?: string[];
  readyProbe?: ReadyProbe;
  envPrefix?: string;
  profileRoot?: string;
  appName?: string;
  obsidianBin?: string;
}

/** {@link RunnerConfig} after discovery, validation, and default resolution. */
export interface ResolvedRunnerConfig {
  pluginId: string;
  vaultPrefix: string;
  pluginArtifacts: string[];
  defaultData: unknown;
  buildCommand: string;
  defaultCommand: string[];
  readyProbe: ReadyProbe;
  envPrefix?: string;
  profileRoot: string;
  appName: string;
  obsidianBin: string;
}

export interface ProvisionRawOptions {
  config?: string;
  data?: string;
  force?: boolean;
  help?: boolean;
  json?: boolean;
  printEnv?: boolean;
  root?: string;
  vault?: string;
  worktree?: string;
}

export interface ProvisionOptions {
  dataPath: string | undefined;
  force: boolean;
  json: boolean;
  printEnv: boolean;
  rootPath: string;
  vaultName: string;
  vaultPath: string;
  worktreePath: string;
}

export interface ProvisionResult {
  pluginPath: string;
  vaultName: string;
  vaultPath: string;
  worktreePath: string;
}

export interface InstanceRawOptions extends ProvisionRawOptions {
  launch?: boolean;
  obsidianApp?: string;
  obsidianBin?: string;
  profileRoot?: string;
  skipVersionGuard?: boolean;
}

export interface InstanceOptions extends ProvisionOptions {
  instanceId: string;
  instancePath: string;
  launch: boolean;
  obsidianApp: string;
  obsidianBin: string;
  obsidianHome: string;
  profileRoot: string;
  skipVersionGuard: boolean;
  userDataPath: string;
}

export interface ProfileResult {
  obsidianJsonPath: string;
  userDataPath: string;
  vaultId: string;
}

/**
 * Sidecar written at the instance root recording which worktree the instance
 * belongs to plus the Obsidian app version it was last prepared against. The
 * teardown reaper reads `worktreePath` to reap an instance only once its
 * worktree is gone; the reuse guard compares `appVersion`.
 */
export interface InstanceMarker {
  appVersion: string | null;
  vaultName: string;
  vaultPath: string;
  worktreePath: string;
}

export interface ProcessInfo {
  command: string;
  pid: number;
  ppid: number;
}

export interface CollectInstanceOptions {
  selfPid?: number;
}

export type KillFunction = (pid: number, signal: NodeJS.Signals | 0) => void;
export type RunPsFunction = () => Promise<string>;
export type RemoveDirFunction = (dir: string) => Promise<void>;
export type ReadFileFunction = (file: string) => Promise<string>;
export type ExistsFunction = (target: string) => Promise<boolean>;
export type ReadDirFunction = (dir: string) => Promise<Dirent[]>;

export interface StopOptions {
  dryRun?: boolean;
  graceMs?: number;
  kill?: KillFunction;
  pollMs?: number;
  profileRoot?: string;
  removeDir?: RemoveDirFunction;
  runPs?: RunPsFunction;
  selfPid?: number;
}

export interface StopResult {
  instancePath: string;
  killed: number[];
  pids: number[];
  removed: boolean;
  terminated: number[];
}

export interface InstanceReadDependencies {
  exists?: ExistsFunction;
  readFile?: ReadFileFunction;
}

export interface ReapOptions extends StopOptions, InstanceReadDependencies {
  exceptInstancePath?: string;
  log?: (message: string) => void;
  readdir?: ReadDirFunction;
}

export interface ReapResult {
  reaped: string[];
  scanned: number;
}
