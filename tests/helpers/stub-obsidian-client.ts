import { attachClientInternals, createRestoreManager } from "../../src/core/internals";
import { createPluginHandle } from "../../src/core/plugin";
import type {
  DevConsoleMessage,
  DevDiagnostics,
  DevNoticeEvent,
  DevDomResult,
  DevRuntimeError,
  ExecResult,
  MetadataFileCache,
  NoteFrontmatter,
  ObsidianClient,
  PluginHandle,
  WaitForOptions,
  WorkspaceNode,
  WorkspaceTab,
} from "../../src/core/types";
import type { HarnessMethodName } from "../../src/dev/harness";

type Awaitable<T> = Promise<T> | T;

interface CreateStubObsidianClientOptions {
  activeFile?: string | null;
  commands?: string[];
  consoleMessages?: DevConsoleMessage[];
  domResult?: DevDomResult;
  editorText?: string | null;
  metadataByPath?: Record<string, MetadataFileCache<NoteFrontmatter> | null>;
  notices?: DevNoticeEvent[];
  onEval?: (code: string) => Awaitable<unknown>;
  onEvalRaw?: (code: string) => Awaitable<string>;
  onScreenshot?: (path: string) => Promise<string> | string;
  pluginFactory?: (client: ObsidianClient, id: string) => PluginHandle;
  readFileForRestore?: (filePath: string) => Promise<string>;
  runtimeErrors?: DevRuntimeError[];
  tabs?: WorkspaceTab[];
  vaultRoot: string;
  waitFor?: <T>(
    callback: () => Promise<T | false | null | undefined> | T | false | null | undefined,
    options?: WaitForOptions,
  ) => Promise<T>;
  workspace?: WorkspaceNode[];
}

export function createStubObsidianClient(options: CreateStubObsidianClientOptions): ObsidianClient {
  const activeFile = options.activeFile ?? null;
  const commandSet = new Set(options.commands ?? []);
  const consoleMessages = options.consoleMessages ?? [];
  const domResult = options.domResult ?? [];
  const editorText = options.editorText ?? null;
  const metadataByPath = options.metadataByPath ?? {};
  const notices = options.notices ?? [];
  const runtimeErrors = options.runtimeErrors ?? [];
  const tabs = options.tabs ?? [];
  const workspace = options.workspace ?? [];
  const diagnostics: DevDiagnostics = {
    consoleMessages,
    notices,
    runtimeErrors,
  };

  const client: ObsidianClient = {
    app: {
      async reload() {},
      async restart() {},
      async version() {
        return "";
      },
      async waitUntilReady() {},
    },
    bin: "obsidian",
    command(id: string) {
      return {
        id,
        async exists() {
          return commandSet.has(id);
        },
        async run() {},
      };
    },
    async commands() {
      return [...commandSet];
    },
    dev: {
      async activeFilePath() {
        return activeFile;
      },
      async consoleMessages() {
        return structuredClone(diagnostics.consoleMessages);
      },
      async diagnostics() {
        return structuredClone(diagnostics);
      },
      async dom() {
        return domResult;
      },
      async editorText() {
        return editorText;
      },
      async eval(code: string) {
        if (options.onEval) {
          return options.onEval(code) as never;
        }

        if (code === "app.workspace.getActiveFile()?.path ?? null") {
          return activeFile as never;
        }

        if (code === "app.workspace.activeLeaf?.view?.editor?.getValue?.() ?? null") {
          return editorText as never;
        }

        throw new Error(`Unhandled dev.eval code: ${code}`);
      },
      async evalRaw(code: string) {
        if (options.onEvalRaw) {
          return options.onEvalRaw(code);
        }

        const harnessResult = runHarnessEval(code, {
          activeFile,
          diagnostics,
          editorText,
          metadataByPath,
        });

        if (harnessResult !== undefined) {
          return harnessResult;
        }

        if (options.onEval) {
          return JSON.stringify({
            ok: true,
            value: await options.onEval(code),
          });
        }

        return code;
      },
      async notices() {
        return structuredClone(diagnostics.notices);
      },
      async resetDiagnostics() {
        diagnostics.consoleMessages.splice(0);
        diagnostics.notices.splice(0);
        diagnostics.runtimeErrors.splice(0);
      },
      async runtimeErrors() {
        return structuredClone(diagnostics.runtimeErrors);
      },
      async screenshot(path: string) {
        if (options.onScreenshot) {
          return options.onScreenshot(path);
        }

        return path;
      },
    },
    async exec(command): Promise<ExecResult> {
      return {
        argv: [],
        command,
        exitCode: 0,
        stderr: "",
        stdout: "",
      };
    },
    async execJson() {
      return {} as never;
    },
    async execText() {
      return "";
    },
    async open() {},
    async openTab() {},
    metadata: {
      async fileCache<T = MetadataFileCache<NoteFrontmatter>>(path: string) {
        return (metadataByPath[path] ?? null) as T | null;
      },
      async frontmatter<T extends NoteFrontmatter = NoteFrontmatter>(path: string) {
        return (metadataByPath[path]?.frontmatter ?? null) as T | null;
      },
      async waitForFileCache<T = MetadataFileCache<NoteFrontmatter>>(
        path: string,
        predicate?: (value: T) => Awaitable<boolean>,
        _options?: WaitForOptions,
      ) {
        return client.waitFor(async () => {
          const value = (metadataByPath[path] ?? null) as T | null;
          if (!value) {
            return false;
          }

          return predicate && !(await predicate(value)) ? false : value;
        });
      },
      async waitForFrontmatter<T extends NoteFrontmatter = NoteFrontmatter>(
        path: string,
        predicate?: (value: T) => Awaitable<boolean>,
        _options?: WaitForOptions,
      ) {
        return client.waitFor(async () => {
          const value = (metadataByPath[path]?.frontmatter ?? null) as T | null;
          if (!value) {
            return false;
          }

          return predicate && !(await predicate(value)) ? false : value;
        });
      },
      async waitForMetadata<T = MetadataFileCache<NoteFrontmatter>>(
        path: string,
        predicate?: (value: T) => Awaitable<boolean>,
        _options?: WaitForOptions,
      ) {
        return client.waitFor(async () => {
          const value = (metadataByPath[path] ?? null) as T | null;
          if (!value) {
            return false;
          }

          return predicate && !(await predicate(value)) ? false : value;
        });
      },
    },
    plugin(id: string) {
      return (options.pluginFactory ?? createPluginHandle)(client, id);
    },
    async sleep() {},
    async tabs() {
      return tabs;
    },
    async vaultPath() {
      return options.vaultRoot;
    },
    async verify() {},
    async waitForActiveFile(path) {
      if (activeFile !== path) {
        throw new Error(`Expected active file ${path}, received ${activeFile}`);
      }

      return path;
    },
    async waitForConsoleMessage(predicate) {
      for (const entry of diagnostics.consoleMessages) {
        if (await predicate(entry)) {
          return entry;
        }
      }

      throw new Error("Missing console message");
    },
    async waitForNotice(predicate) {
      const matcher =
        typeof predicate === "string"
          ? (notice: DevNoticeEvent) => notice.message.includes(predicate)
          : predicate;
      for (const entry of diagnostics.notices) {
        if (await matcher(entry)) {
          return entry;
        }
      }

      throw new Error("Missing notice");
    },
    async waitForRuntimeError(predicate) {
      const matcher =
        typeof predicate === "string"
          ? (error: DevRuntimeError) => error.message.includes(predicate)
          : predicate;
      for (const entry of diagnostics.runtimeErrors) {
        if (await matcher(entry)) {
          return entry;
        }
      }

      throw new Error("Missing runtime error");
    },
    async waitFor(callback, waitOptions) {
      if (options.waitFor) {
        return options.waitFor(callback, waitOptions);
      }

      return (await callback()) as never;
    },
    async workspace() {
      return workspace;
    },
    vaultName: "dev",
  };

  if (options.readFileForRestore) {
    attachClientInternals(client, createRestoreManager(options.readFileForRestore));
  }

  return client;
}

function runHarnessEval(
  code: string,
  state: {
    activeFile: string | null;
    diagnostics: DevDiagnostics;
    editorText: string | null;
    metadataByPath: Record<string, MetadataFileCache<NoteFrontmatter> | null>;
  },
): string | undefined {
  const methodMatch = code.match(/const __obsidianE2EMethod = "([^"]+)";/u);
  const argsMatch = code.match(/const __obsidianE2EArgs = (\[[\s\S]*?\]);/u);

  if (!methodMatch) {
    return undefined;
  }

  const method = methodMatch[1] as HarnessMethodName;
  const args = argsMatch ? (JSON.parse(argsMatch[1]!) as unknown[]) : [];

  const ok = (value: unknown) => JSON.stringify({ ok: true, value });

  switch (method) {
    case "activeFilePath":
      return ok(state.activeFile);
    case "consoleMessages":
      return ok(state.diagnostics.consoleMessages);
    case "diagnostics":
      return ok(state.diagnostics);
    case "editorText":
      return ok(state.editorText);
    case "eval":
      return ok(null);
    case "frontmatter":
      return ok(state.metadataByPath[String(args[0])]?.frontmatter ?? null);
    case "metadata":
      return ok(state.metadataByPath[String(args[0])] ?? null);
    case "notices":
      return ok(state.diagnostics.notices);
    case "pluginLoaded":
      return ok(true);
    case "resetDiagnostics":
      state.diagnostics.consoleMessages.splice(0);
      state.diagnostics.notices.splice(0);
      state.diagnostics.runtimeErrors.splice(0);
      return ok(true);
    case "runtimeErrors":
      return ok(state.diagnostics.runtimeErrors);
    default:
      return undefined;
  }
}
