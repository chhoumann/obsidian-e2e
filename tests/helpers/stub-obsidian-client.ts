import { attachClientInternals, createRestoreManager } from "../../src/core/internals";
import { createPluginHandle } from "../../src/core/plugin";
import type {
  DevDomResult,
  ExecResult,
  ObsidianClient,
  PluginHandle,
  WorkspaceNode,
  WorkspaceTab,
} from "../../src/core/types";

type Awaitable<T> = Promise<T> | T;

interface CreateStubObsidianClientOptions {
  activeFile?: string | null;
  commands?: string[];
  domResult?: DevDomResult;
  editorText?: string | null;
  onEval?: (code: string) => Awaitable<unknown>;
  onScreenshot?: (path: string) => Promise<string> | string;
  pluginFactory?: (client: ObsidianClient, id: string) => PluginHandle;
  readFileForRestore?: (filePath: string) => Promise<string>;
  tabs?: WorkspaceTab[];
  vaultRoot: string;
  workspace?: WorkspaceNode[];
}

export function createStubObsidianClient(options: CreateStubObsidianClientOptions): ObsidianClient {
  const activeFile = options.activeFile ?? null;
  const commandSet = new Set(options.commands ?? []);
  const domResult = options.domResult ?? [];
  const editorText = options.editorText ?? null;
  const tabs = options.tabs ?? [];
  const workspace = options.workspace ?? [];

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
      async dom() {
        return domResult;
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
    plugin(id: string) {
      return (options.pluginFactory ?? createPluginHandle)(client, id);
    },
    async tabs() {
      return tabs;
    },
    async vaultPath() {
      return options.vaultRoot;
    },
    async verify() {},
    async waitFor(callback) {
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
