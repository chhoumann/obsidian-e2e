export type ObsidianArg = boolean | number | string | null | undefined

export interface ExecOptions {
  allowNonZeroExit?: boolean
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface ExecResult {
  argv: string[]
  command: string
  exitCode: number
  stderr: string
  stdout: string
}

export interface ExecuteRequest extends ExecOptions {
  argv: string[]
  bin: string
}

export type CommandTransport = (request: ExecuteRequest) => Promise<ExecResult>

export interface WaitForOptions {
  intervalMs?: number
  message?: string
  timeoutMs?: number
}

export type JsonFileUpdater<T> = (draft: T) => Promise<T | void> | T | void

export interface JsonFile<T = unknown> {
  patch(updater: JsonFileUpdater<T>): Promise<T>
  read(): Promise<T>
  write(value: T): Promise<void>
}

export interface PluginHandle {
  readonly id: string

  data<T = unknown>(): JsonFile<T>
  dataPath(): Promise<string>
  isEnabled(): Promise<boolean>
  reload(): Promise<void>
  restoreData(): Promise<void>
}

export interface ObsidianClient {
  readonly bin: string
  readonly vaultName: string

  exec(
    command: string,
    args?: Record<string, ObsidianArg>,
    options?: ExecOptions,
  ): Promise<ExecResult>
  execJson<T = unknown>(
    command: string,
    args?: Record<string, ObsidianArg>,
    options?: ExecOptions,
  ): Promise<T>
  execText(
    command: string,
    args?: Record<string, ObsidianArg>,
    options?: ExecOptions,
  ): Promise<string>
  plugin(id: string): PluginHandle
  vaultPath(): Promise<string>
  verify(): Promise<void>
  waitFor<T>(
    fn: () => Promise<T | false | null | undefined> | T | false | null | undefined,
    options?: WaitForOptions,
  ): Promise<T>
}

export interface CreateObsidianClientOptions {
  bin?: string
  intervalMs?: number
  timeoutMs?: number
  transport?: CommandTransport
  vault: string
}

export interface DeleteOptions {
  permanent?: boolean
}

export interface VaultApi {
  delete(path: string, options?: DeleteOptions): Promise<void>
  exists(path: string): Promise<boolean>
  json<T = unknown>(path: string): JsonFile<T>
  mkdir(path: string): Promise<void>
  read(path: string): Promise<string>
  waitForExists(path: string, options?: WaitForOptions): Promise<void>
  waitForMissing(path: string, options?: WaitForOptions): Promise<void>
  write(path: string, content: string): Promise<void>
}

export interface SandboxApi extends VaultApi {
  readonly root: string

  cleanup(): Promise<void>
  path(...segments: string[]): string
}
