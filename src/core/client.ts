import { buildCommandArgv } from "./args";
import { buildHarnessCallCode, createDevDiagnostics, parseHarnessEnvelope } from "../dev/harness";
import { mergeExecOptions } from "./exec-options";
import { attachClientInternals, createRestoreManager } from "./internals";
import { createObsidianMetadataHandle } from "../metadata/metadata";
import { createPluginHandle } from "../plugin/plugin";
import { executeCommand } from "./transport";
import type {
  CommandListOptions,
  CreateObsidianClientOptions,
  DevConsoleMessage,
  DevDiagnostics,
  DevNoticeEvent,
  DevDomQueryOptions,
  DevDomResult,
  DevRuntimeError,
  ExecOptions,
  ObsidianArg,
  ObsidianAppHandle,
  ObsidianCommandHandle,
  ObsidianClient,
  ObsidianDevHandle,
  OpenFileOptions,
  OpenTabOptions,
  RestartAppOptions,
  TabsOptions,
  WaitForOptions,
  WorkspaceNode,
  WorkspaceOptions,
  WorkspaceTab,
} from "./types";
import { DevEvalError } from "./errors";
import { sleep, waitForValue } from "./wait";

export function createObsidianClient(options: CreateObsidianClientOptions): ObsidianClient {
  const transport = options.transport ?? executeCommand;
  const defaultExecOptions = options.defaultExecOptions;
  const waitDefaults = {
    intervalMs: options.intervalMs,
    timeoutMs: options.timeoutMs,
  };

  const restoreManager = createRestoreManager(async (filePath) => {
    const { readFile } = await import("node:fs/promises");
    return readFile(filePath, "utf8");
  });

  let cachedVaultPath: string | undefined;

  const client = {} as ObsidianClient;
  const metadata = createObsidianMetadataHandle(client);

  const app: ObsidianAppHandle = {
    async reload(execOptions: ExecOptions = {}) {
      await client.exec("reload", {}, execOptions);
    },
    async restart({
      readyOptions,
      waitUntilReady = true,
      ...execOptions
    }: RestartAppOptions & ExecOptions = {}) {
      await client.exec("restart", {}, execOptions);

      if (waitUntilReady) {
        await app.waitUntilReady(readyOptions);
      }
    },
    version(execOptions: ExecOptions = {}) {
      return client.execText("version", {}, execOptions);
    },
    async waitUntilReady(waitOptions?: WaitForOptions) {
      await client.waitFor(async () => {
        try {
          await client.vaultPath();
          await client.commands();
          return true;
        } catch {
          return false;
        }
      }, waitOptions);
    },
  };

  const dev: ObsidianDevHandle = {
    async diagnostics(execOptions: ExecOptions = {}): Promise<DevDiagnostics> {
      return createDevDiagnostics(
        parseHarnessEnvelope<DevDiagnostics>(
          await this.evalRaw(buildHarnessCallCode("diagnostics"), execOptions),
        ),
      );
    },
    async dom(options: DevDomQueryOptions, execOptions: ExecOptions = {}): Promise<DevDomResult> {
      const output = await client.execText(
        "dev:dom",
        {
          all: options.all,
          attr: options.attr,
          css: options.css,
          inner: options.inner,
          selector: options.selector,
          text: options.text,
          total: options.total,
        },
        execOptions,
      );

      if (options.total) {
        return Number.parseInt(output, 10);
      }

      if (options.all) {
        return output ? output.split(/\r?\n/u).filter(Boolean) : [];
      }

      return output;
    },
    async eval<T = unknown>(code: string, execOptions: ExecOptions = {}) {
      try {
        return parseHarnessEnvelope<T>(
          await this.evalRaw(buildHarnessCallCode("eval", code), execOptions),
        );
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "message" in error &&
          "name" in error &&
          typeof error.message === "string" &&
          typeof error.name === "string"
        ) {
          throw new DevEvalError(`Failed to evaluate Obsidian code: ${error.message}`, {
            message: error.message,
            name: error.name,
            stack: "stack" in error && typeof error.stack === "string" ? error.stack : undefined,
          });
        }

        throw error;
      }
    },
    async evalRaw(code: string, execOptions: ExecOptions = {}) {
      return client.execText(
        "eval",
        {
          code,
        },
        execOptions,
      );
    },
    async resetDiagnostics(execOptions: ExecOptions = {}) {
      parseHarnessEnvelope<void>(
        await this.evalRaw(buildHarnessCallCode("resetDiagnostics"), execOptions),
      );
    },
    async screenshot(targetPath: string, execOptions: ExecOptions = {}) {
      await client.exec(
        "dev:screenshot",
        {
          path: targetPath,
        },
        execOptions,
      );

      return targetPath;
    },
  };

  Object.assign(client, {
    app,
    bin: options.bin ?? "obsidian",
    dev,
    metadata,
    command(id: string): ObsidianCommandHandle {
      return {
        async exists(commandOptions: CommandListOptions = {}) {
          const commands = await client.commands({
            ...commandOptions,
            filter: commandOptions.filter ?? id,
          });

          return commands.includes(id);
        },
        id,
        async run(execOptions: ExecOptions = {}) {
          await client.exec("command", { id }, execOptions);
        },
      };
    },
    async commands(
      commandOptions: CommandListOptions = {},
      execOptions: ExecOptions = {},
    ): Promise<string[]> {
      const output = await client.execText(
        "commands",
        {
          filter: commandOptions.filter,
        },
        execOptions,
      );
      return parseCommandIds(output);
    },
    exec(command: string, args: Record<string, ObsidianArg> = {}, execOptions: ExecOptions = {}) {
      return transport({
        ...mergeExecOptions(defaultExecOptions, execOptions),
        argv: buildCommandArgv(options.vault, command, args),
        bin: this.bin,
      });
    },
    async execJson<T = unknown>(
      command: string,
      args: Record<string, ObsidianArg> = {},
      execOptions: ExecOptions = {},
    ) {
      const output = await this.execText(command, args, execOptions);
      return JSON.parse(output) as T;
    },
    async execText(
      command: string,
      args: Record<string, ObsidianArg> = {},
      execOptions: ExecOptions = {},
    ) {
      const result = await this.exec(command, args, execOptions);
      return result.stdout.trimEnd();
    },
    async open(openOptions: OpenFileOptions, execOptions: ExecOptions = {}) {
      await client.exec(
        "open",
        {
          file: openOptions.file,
          newtab: openOptions.newTab,
          path: openOptions.path,
        },
        execOptions,
      );
    },
    async openTab(tabOptions: OpenTabOptions = {}, execOptions: ExecOptions = {}) {
      await client.exec(
        "tab:open",
        {
          file: tabOptions.file,
          group: tabOptions.group,
          view: tabOptions.view,
        },
        execOptions,
      );
    },
    plugin(id: string) {
      return createPluginHandle(this, id);
    },
    sleep(ms: number) {
      return sleep(ms);
    },
    async tabs(
      tabOptions: TabsOptions = {},
      execOptions: ExecOptions = {},
    ): Promise<WorkspaceTab[]> {
      const output = await client.execText(
        "tabs",
        {
          ids: tabOptions.ids ?? true,
        },
        execOptions,
      );
      return parseTabs(output);
    },
    async vaultPath() {
      if (!cachedVaultPath) {
        cachedVaultPath = await this.execText("vault", { info: "path" });
      }

      return cachedVaultPath;
    },
    async verify() {
      await transport({
        ...mergeExecOptions(defaultExecOptions, undefined),
        argv: ["--help"],
        bin: this.bin,
      });

      await this.vaultPath();
    },
    vaultName: options.vault,
    async waitForActiveFile(path: string, options?: WaitForOptions) {
      return client.waitFor(
        async () => {
          const activePath = parseHarnessEnvelope<string | null>(
            await dev.evalRaw(buildHarnessCallCode("activeFilePath")),
          );

          return activePath === path ? activePath : false;
        },
        {
          ...options,
          message: options?.message ?? `active file "${path}"`,
        },
      );
    },
    async waitForConsoleMessage(
      predicate: (message: DevConsoleMessage) => boolean | Promise<boolean>,
      options?: WaitForOptions,
    ) {
      return waitForDiagnosticEntry(
        client,
        (diagnostics) => diagnostics.consoleMessages,
        predicate,
        options?.message ?? "console message",
        options,
      );
    },
    async waitForNotice(
      predicate: string | ((notice: DevNoticeEvent) => boolean | Promise<boolean>),
      options?: WaitForOptions,
    ) {
      return waitForDiagnosticEntry(
        client,
        (diagnostics) => diagnostics.notices,
        typeof predicate === "string" ? (notice) => notice.message.includes(predicate) : predicate,
        options?.message ?? "notice",
        options,
      );
    },
    async waitForRuntimeError(
      predicate: string | ((error: DevRuntimeError) => boolean | Promise<boolean>),
      options?: WaitForOptions,
    ) {
      return waitForDiagnosticEntry(
        client,
        (diagnostics) => diagnostics.runtimeErrors,
        typeof predicate === "string" ? (error) => error.message.includes(predicate) : predicate,
        options?.message ?? "runtime error",
        options,
      );
    },
    waitFor<T>(
      fn: () => Promise<T | false | null | undefined> | T | false | null | undefined,
      waitOptions?: WaitForOptions,
    ) {
      return waitForValue(fn, {
        ...waitDefaults,
        ...waitOptions,
      });
    },
    async workspace(
      workspaceOptions: WorkspaceOptions = {},
      execOptions: ExecOptions = {},
    ): Promise<WorkspaceNode[]> {
      const output = await client.execText(
        "workspace",
        {
          ids: workspaceOptions.ids ?? true,
        },
        execOptions,
      );
      return parseWorkspace(output);
    },
  });

  attachClientInternals(client, restoreManager);

  return client;
}

function parseCommandIds(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t", 1)[0]?.trim() ?? "")
    .filter(Boolean);
}

function parseTabs(output: string): WorkspaceTab[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseTabLine);
}

function parseTabLine(line: string): WorkspaceTab {
  const [descriptor, id] = line.split("\t");
  const match = descriptor?.match(/^\[(.+?)\]\s+(.*)$/u);

  if (!match) {
    return {
      id: id?.trim() || undefined,
      title: descriptor?.trim() ?? "",
      viewType: "unknown",
    };
  }

  return {
    id: id?.trim() || undefined,
    title: match[2]!,
    viewType: match[1]!,
  };
}

function parseWorkspace(output: string): WorkspaceNode[] {
  const roots: WorkspaceNode[] = [];
  const stack: Array<{ depth: number; node: WorkspaceNode }> = [];

  for (const rawLine of output.split(/\r?\n/u)) {
    if (!rawLine.trim()) {
      continue;
    }

    const depth = getWorkspaceDepth(rawLine);
    const node = parseWorkspaceNode(rawLine);

    while (stack.length > 0 && stack.at(-1)!.depth >= depth) {
      stack.pop();
    }

    const parent = stack.at(-1)?.node;

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }

    stack.push({ depth, node });
  }

  return roots;
}

async function waitForDiagnosticEntry<T>(
  client: ObsidianClient,
  select: (diagnostics: DevDiagnostics) => T[],
  predicate: (entry: T) => boolean | Promise<boolean>,
  label: string,
  options?: WaitForOptions,
): Promise<T> {
  return client.waitFor(
    async () => {
      const entries = select(await client.dev.diagnostics());

      for (const entry of entries) {
        if (await predicate(entry)) {
          return entry;
        }
      }

      return false;
    },
    {
      ...options,
      message: options?.message ?? label,
    },
  );
}

function getWorkspaceDepth(line: string): number {
  let depth = 0;
  let remainder = line;

  while (true) {
    if (
      remainder.startsWith("│   ") ||
      remainder.startsWith("    ") ||
      remainder.startsWith("├── ") ||
      remainder.startsWith("└── ")
    ) {
      depth += 1;
      remainder = remainder.slice(4);
      continue;
    }

    return depth;
  }
}

function parseWorkspaceNode(line: string): WorkspaceNode {
  let withoutTree = line;

  while (true) {
    if (
      withoutTree.startsWith("│   ") ||
      withoutTree.startsWith("    ") ||
      withoutTree.startsWith("├── ") ||
      withoutTree.startsWith("└── ")
    ) {
      withoutTree = withoutTree.slice(4);
      continue;
    }

    break;
  }

  withoutTree = withoutTree.trim();
  const idMatch = withoutTree.match(/^(.*?)(?: \(([a-z0-9]+)\))?$/iu);
  const content = idMatch?.[1]?.trim() ?? withoutTree;
  const id = idMatch?.[2];
  const leafMatch = content.match(/^\[(.+?)\]\s+(.*)$/u);

  if (leafMatch) {
    return {
      children: [],
      id,
      label: leafMatch[2]!,
      title: leafMatch[2]!,
      viewType: leafMatch[1]!,
    };
  }

  return {
    children: [],
    id,
    label: content,
  };
}
