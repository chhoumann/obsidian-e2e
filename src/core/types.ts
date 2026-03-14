export type ObsidianArg = boolean | number | string | null | undefined

export interface ExecOptions {
  allowNonZeroExit?: boolean
  timeoutMs?: number
}

export interface ExecResult {
  argv: string[]
  command: string
  exitCode: number
  stderr: string
  stdout: string
}

export interface WaitForOptions {
  intervalMs?: number
  message?: string
  timeoutMs?: number
}

export interface JsonFile<T = unknown> {
  path(): Promise<string> | string
  read(): Promise<T>
  write(value: T): Promise<void>
  patch(updater: (draft: T) => T | void): Promise<T>
}

export interface PluginHandle {
  readonly id: string

  data<T = unknown>(): JsonFile<T>
  dataPath(): Promise<string>
  isEnabled(): Promise<boolean>
  reload(): Promise<void>
}

export interface VaultApi {
  delete(path: string, options?: { permanent?: boolean }): Promise<void>
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

  path(...segments: string[]): string
}

export interface ObsidianClientOptions {
  bin?: string
  intervalMs?: number
  timeoutMs?: number
  vault: string
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
    callback: () => Promise<T | false | null | undefined> | T | false | null | undefined,
    options?: WaitForOptions,
  ): Promise<T>
}
