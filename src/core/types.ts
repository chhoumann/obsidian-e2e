export type ObsidianArg = boolean | number | string | null | undefined;

export type FrontmatterValue =
  | boolean
  | number
  | string
  | null
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export interface NoteFrontmatter {
  [key: string]: FrontmatterValue;
}

export interface NoteDocument<
  TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null,
> {
  body: string;
  frontmatter: TFrontmatter;
  raw: string;
}

export interface NoteInput<TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null> {
  body?: string;
  frontmatter?: TFrontmatter;
}

export interface NoteMatcherOptions<
  TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null,
> {
  body?: string;
  bodyIncludes?: string;
  frontmatter?: TFrontmatter;
}

export interface MetadataFileCache<
  TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null,
> extends Record<string, unknown> {
  frontmatter?: TFrontmatter;
}

export interface DevEvalErrorPayload {
  message: string;
  name: string;
  stack?: string;
}

export interface DevConsoleMessage {
  args: unknown[];
  at: number;
  level: string;
  text: string;
}

export interface DevRuntimeError {
  at: number;
  message: string;
  source: "error" | "unhandledrejection";
  stack?: string;
}

export interface DevNoticeEvent {
  at: number;
  message: string;
  timeout?: number;
}

export interface DevDiagnostics {
  consoleMessages: DevConsoleMessage[];
  notices: DevNoticeEvent[];
  runtimeErrors: DevRuntimeError[];
}

export interface ExecOptions {
  allowNonZeroExit?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type VaultContentPredicate = (content: string) => boolean | Promise<boolean>;

export type VaultWaitForContentOptions = WaitForOptions;

export interface VaultWriteOptions {
  waitForContent?: boolean | VaultContentPredicate;
  waitOptions?: VaultWaitForContentOptions;
}

export type MetadataPredicate<T = MetadataFileCache> = (metadata: T) => boolean | Promise<boolean>;

export type MetadataWaitOptions = WaitForOptions;

export interface SandboxWriteNoteOptions<
  TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null,
> extends NoteInput<TFrontmatter> {
  path: string;
  waitForMetadata?:
    | boolean
    | MetadataPredicate<MetadataFileCache<Extract<TFrontmatter, NoteFrontmatter> | null>>;
  waitOptions?: MetadataWaitOptions;
}

export type PluginDataPredicate<T = unknown> = (data: T) => boolean | Promise<boolean>;

export type PluginWaitForDataOptions = WaitForOptions;

export interface PluginWaitUntilReadyOptions extends WaitForOptions {
  commandId?: string;
}

export interface PluginReloadOptions extends ExecOptions {
  readyOptions?: PluginWaitUntilReadyOptions;
  waitUntilReady?: boolean;
}

export interface PluginPatchDataOptions<T> extends PluginReloadOptions {
  patch?: JsonFileUpdater<T>;
}

export type PluginUpdateDataOptions<T> = PluginPatchDataOptions<T>;

export type PluginWithPatchedDataOptions<T> = PluginPatchDataOptions<T>;

export interface ExecResult {
  argv: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface ExecuteRequest extends ExecOptions {
  argv: string[];
  bin: string;
}

export type CommandTransport = (request: ExecuteRequest) => Promise<ExecResult>;

export interface WaitForOptions {
  intervalMs?: number;
  message?: string;
  timeoutMs?: number;
}

export interface CommandListOptions {
  filter?: string;
}

export interface OpenFileOptions {
  file?: string;
  newTab?: boolean;
  path?: string;
}

export interface OpenTabOptions {
  file?: string;
  group?: string;
  view?: string;
}

export interface PluginToggleOptions {
  filter?: "community" | "core";
}

export interface RestartAppOptions {
  readyOptions?: WaitForOptions;
  waitUntilReady?: boolean;
}

export interface TabsOptions {
  ids?: boolean;
}

export interface WorkspaceOptions {
  ids?: boolean;
}

export type JsonFileUpdater<T> = (draft: T) => Promise<T | void> | T | void;

export interface JsonFile<T = unknown> {
  patch(updater: JsonFileUpdater<T>): Promise<T>;
  read(): Promise<T>;
  write(value: T): Promise<void>;
}

export interface PluginHandle {
  readonly id: string;

  data<T = unknown>(): JsonFile<T>;
  dataPath(): Promise<string>;
  disable(options?: PluginToggleOptions): Promise<void>;
  enable(options?: PluginToggleOptions): Promise<void>;
  isEnabled(): Promise<boolean>;
  reload(options?: PluginReloadOptions): Promise<void>;
  restoreData(): Promise<void>;
  updateDataAndReload<T = unknown>(
    updater: JsonFileUpdater<T>,
    options?: PluginUpdateDataOptions<T>,
  ): Promise<T>;
  withPatchedData<T = unknown, TResult = void>(
    updater: JsonFileUpdater<T>,
    run: (plugin: PluginHandle) => Promise<TResult> | TResult,
    options?: PluginWithPatchedDataOptions<T>,
  ): Promise<TResult>;
  waitForData<T = unknown>(
    predicate: PluginDataPredicate<T>,
    options?: PluginWaitForDataOptions,
  ): Promise<T>;
  waitUntilReady(options?: PluginWaitUntilReadyOptions): Promise<void>;
}

export interface ObsidianAppHandle {
  reload(options?: ExecOptions): Promise<void>;
  restart(options?: RestartAppOptions & ExecOptions): Promise<void>;
  version(options?: ExecOptions): Promise<string>;
  waitUntilReady(options?: WaitForOptions): Promise<void>;
}

export interface ObsidianCommandHandle {
  readonly id: string;

  exists(options?: CommandListOptions): Promise<boolean>;
  run(options?: ExecOptions): Promise<void>;
}

export interface ObsidianDevHandle {
  activeFilePath(execOptions?: ExecOptions): Promise<string | null>;
  consoleMessages(execOptions?: ExecOptions): Promise<DevConsoleMessage[]>;
  diagnostics(execOptions?: ExecOptions): Promise<DevDiagnostics>;
  dom(options: DevDomQueryOptions, execOptions?: ExecOptions): Promise<DevDomResult>;
  editorText(execOptions?: ExecOptions): Promise<string | null>;
  eval<T = unknown>(code: string, options?: ExecOptions): Promise<T>;
  evalRaw(code: string, options?: ExecOptions): Promise<string>;
  notices(execOptions?: ExecOptions): Promise<DevNoticeEvent[]>;
  resetDiagnostics(execOptions?: ExecOptions): Promise<void>;
  runtimeErrors(execOptions?: ExecOptions): Promise<DevRuntimeError[]>;
  screenshot(path: string, options?: ExecOptions): Promise<string>;
}

export interface ObsidianMetadataHandle {
  fileCache<T = MetadataFileCache>(path: string, execOptions?: ExecOptions): Promise<T | null>;
  frontmatter<T extends NoteFrontmatter = NoteFrontmatter>(
    path: string,
    execOptions?: ExecOptions,
  ): Promise<T | null>;
  waitForFileCache<T = MetadataFileCache>(
    path: string,
    predicate?: MetadataPredicate<T>,
    options?: MetadataWaitOptions,
  ): Promise<T>;
  waitForFrontmatter<T extends NoteFrontmatter = NoteFrontmatter>(
    path: string,
    predicate?: MetadataPredicate<T>,
    options?: MetadataWaitOptions,
  ): Promise<T>;
  waitForMetadata<T = MetadataFileCache>(
    path: string,
    predicate?: MetadataPredicate<T>,
    options?: MetadataWaitOptions,
  ): Promise<T>;
}

export type DevDomResult = number | string | string[];

export interface DevDomQueryOptions {
  all?: boolean;
  attr?: string;
  css?: string;
  inner?: boolean;
  selector: string;
  text?: boolean;
  total?: boolean;
}

export interface WorkspaceNode {
  children: WorkspaceNode[];
  id?: string;
  label: string;
  title?: string;
  viewType?: string;
}

export interface WorkspaceTab {
  id?: string;
  title: string;
  viewType: string;
}

export interface ObsidianClient {
  readonly app: ObsidianAppHandle;
  readonly bin: string;
  readonly dev: ObsidianDevHandle;
  readonly metadata: ObsidianMetadataHandle;
  readonly vaultName: string;

  command(id: string): ObsidianCommandHandle;
  commands(options?: CommandListOptions, execOptions?: ExecOptions): Promise<string[]>;
  exec(
    command: string,
    args?: Record<string, ObsidianArg>,
    options?: ExecOptions,
  ): Promise<ExecResult>;
  execJson<T = unknown>(
    command: string,
    args?: Record<string, ObsidianArg>,
    options?: ExecOptions,
  ): Promise<T>;
  execText(
    command: string,
    args?: Record<string, ObsidianArg>,
    options?: ExecOptions,
  ): Promise<string>;
  open(options: OpenFileOptions, execOptions?: ExecOptions): Promise<void>;
  openTab(options?: OpenTabOptions, execOptions?: ExecOptions): Promise<void>;
  plugin(id: string): PluginHandle;
  sleep(ms: number): Promise<void>;
  tabs(options?: TabsOptions, execOptions?: ExecOptions): Promise<WorkspaceTab[]>;
  vaultPath(): Promise<string>;
  verify(): Promise<void>;
  waitForActiveFile(path: string, options?: WaitForOptions): Promise<string>;
  waitForConsoleMessage(
    predicate: (message: DevConsoleMessage) => boolean | Promise<boolean>,
    options?: WaitForOptions,
  ): Promise<DevConsoleMessage>;
  waitForNotice(
    predicate: string | ((notice: DevNoticeEvent) => boolean | Promise<boolean>),
    options?: WaitForOptions,
  ): Promise<DevNoticeEvent>;
  waitForRuntimeError(
    predicate: string | ((error: DevRuntimeError) => boolean | Promise<boolean>),
    options?: WaitForOptions,
  ): Promise<DevRuntimeError>;
  waitFor<T>(
    fn: () => Promise<T | false | null | undefined> | T | false | null | undefined,
    options?: WaitForOptions,
  ): Promise<T>;
  workspace(options?: WorkspaceOptions, execOptions?: ExecOptions): Promise<WorkspaceNode[]>;
}

export interface CreateObsidianClientOptions {
  bin?: string;
  defaultExecOptions?: ExecOptions;
  intervalMs?: number;
  timeoutMs?: number;
  transport?: CommandTransport;
  vault: string;
}

export interface DeleteOptions {
  permanent?: boolean;
}

export interface VaultApi {
  delete(path: string, options?: DeleteOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
  json<T = unknown>(path: string): JsonFile<T>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  waitForContent(
    path: string,
    predicate: VaultContentPredicate,
    options?: VaultWaitForContentOptions,
  ): Promise<string>;
  waitForExists(path: string, options?: WaitForOptions): Promise<void>;
  waitForMissing(path: string, options?: WaitForOptions): Promise<void>;
  write(path: string, content: string, options?: VaultWriteOptions): Promise<void>;
}

export interface SandboxApi extends VaultApi {
  readonly root: string;

  cleanup(): Promise<void>;
  frontmatter<T extends NoteFrontmatter = NoteFrontmatter>(path: string): Promise<T | null>;
  path(...segments: string[]): string;
  readNote<TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null>(
    path: string,
  ): Promise<NoteDocument<TFrontmatter>>;
  waitForFrontmatter<T extends NoteFrontmatter = NoteFrontmatter>(
    path: string,
    predicate?: MetadataPredicate<T>,
    options?: MetadataWaitOptions,
  ): Promise<T>;
  waitForMetadata<T = MetadataFileCache>(
    path: string,
    predicate?: MetadataPredicate<T>,
    options?: MetadataWaitOptions,
  ): Promise<T>;
  writeNote<TFrontmatter extends NoteFrontmatter | null = NoteFrontmatter | null>(
    options: SandboxWriteNoteOptions<TFrontmatter>,
  ): Promise<NoteDocument<TFrontmatter>>;
}
