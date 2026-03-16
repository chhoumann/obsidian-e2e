import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vite-plus/test";

import { createObsidianClient } from "../../src/core/client";
import { DevEvalError } from "../../src/core/errors";
import { mergeExecOptions } from "../../src/core/exec-options";
import type { CommandTransport } from "../../src/core/types";

describe("createObsidianClient", () => {
  test("builds obsidian commands with the vault prefix", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: ["vault=dev", "quickadd:run", "choice=sample"],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout: '{"ok":true}\n',
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    const result = await client.execJson("quickadd:run", { choice: "sample" });

    expect(result).toEqual({ ok: true });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["vault=dev", "quickadd:run", "choice=sample"],
        bin: "obsidian",
      }),
    );
  });

  test("verifies the binary and caches the vault path", async () => {
    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[0] === "--help") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "usage",
        };
      }

      return {
        argv: request.argv,
        command: request.bin,
        exitCode: 0,
        stderr: "",
        stdout: "/tmp/vault\n",
      };
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await client.verify();
    expect(await client.vaultPath()).toBe("/tmp/vault");
    expect(await client.vaultPath()).toBe("/tmp/vault");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test("lists commands and filters command ids", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: ["vault=dev", "commands", "filter=workspace:"],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout: "workspace:save\tSave workspace\nworkspace:load\tLoad workspace\n",
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await expect(client.commands({ filter: "workspace:" })).resolves.toEqual([
      "workspace:save",
      "workspace:load",
    ]);
  });

  test("runs commands through command handles and checks existence", async () => {
    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[1] === "commands") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "workspace:save\nworkspace:save-as\n",
        };
      }

      if (request.argv[1] === "command") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "",
        };
      }

      throw new Error(`Unhandled request: ${request.argv.join(" ")}`);
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await expect(client.command("workspace:save").exists()).resolves.toBe(true);
    await expect(client.command("workspace:delete").exists()).resolves.toBe(false);
    await client.command("workspace:save").run();

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["vault=dev", "command", "id=workspace:save"],
      }),
    );
  });

  test("merges default exec options into command requests", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: ["vault=dev", "version"],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout: "1.8.10\n",
    });

    const client = createObsidianClient({
      defaultExecOptions: {
        allowNonZeroExit: true,
        cwd: "/tmp/default",
        env: {
          BASE: "1",
        },
        timeoutMs: 1000,
      },
      transport,
      vault: "dev",
    });

    await client.app.version({
      env: {
        EXTRA: "2",
      },
      timeoutMs: 250,
    });

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        allowNonZeroExit: true,
        argv: ["vault=dev", "version"],
        cwd: "/tmp/default",
        env: {
          BASE: "1",
          EXTRA: "2",
        },
        timeoutMs: 250,
      }),
    );
  });

  test("applies default exec options to plugin and command handles", async () => {
    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[1] === "plugin:reload" || request.argv[1] === "command") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "",
        };
      }

      throw new Error(`Unhandled request: ${request.argv.join(" ")}`);
    });

    const client = createObsidianClient({
      defaultExecOptions: {
        cwd: "/tmp/default",
        env: {
          BASE: "1",
        },
      },
      transport,
      vault: "dev",
    });

    await client.plugin("quickadd").reload({
      env: {
        EXTRA: "2",
      },
    });
    await client.command("workspace:save").run();

    expect(transport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        argv: ["vault=dev", "plugin:reload", "id=quickadd"],
        cwd: "/tmp/default",
        env: {
          BASE: "1",
          EXTRA: "2",
        },
      }),
    );
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        argv: ["vault=dev", "command", "id=workspace:save"],
        cwd: "/tmp/default",
        env: {
          BASE: "1",
        },
      }),
    );
  });

  test("applies default exec options to command and dev helpers", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: [],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout: "",
    });

    const client = createObsidianClient({
      defaultExecOptions: {
        allowNonZeroExit: true,
        cwd: "/tmp/default",
        timeoutMs: 1000,
      },
      transport,
      vault: "dev",
    });

    await client.command("workspace:save").run();
    await client.dev.screenshot("/tmp/shot.png", {
      timeoutMs: 250,
    });

    expect(transport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        allowNonZeroExit: true,
        argv: ["vault=dev", "command", "id=workspace:save"],
        cwd: "/tmp/default",
        timeoutMs: 1000,
      }),
    );
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        allowNonZeroExit: true,
        argv: ["vault=dev", "dev:screenshot", "path=/tmp/shot.png"],
        cwd: "/tmp/default",
        timeoutMs: 250,
      }),
    );
  });

  test("applies default exec options to verify requests", async () => {
    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[0] === "--help") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "usage\n",
        };
      }

      return {
        argv: request.argv,
        command: request.bin,
        exitCode: 0,
        stderr: "",
        stdout: "/tmp/vault\n",
      };
    });

    const client = createObsidianClient({
      defaultExecOptions: {
        allowNonZeroExit: true,
        cwd: "/tmp/default",
        timeoutMs: 1000,
      },
      transport,
      vault: "dev",
    });

    await client.verify();

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        allowNonZeroExit: true,
        argv: ["--help"],
        cwd: "/tmp/default",
        timeoutMs: 1000,
      }),
    );
  });

  test("exposes app version, reload, restart, and readiness helpers", async () => {
    let commandsAttempts = 0;

    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[1] === "vault") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "/tmp/vault\n",
        };
      }

      if (request.argv[1] === "version") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "1.8.10\n",
        };
      }

      if (request.argv[1] === "reload" || request.argv[1] === "restart") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "",
        };
      }

      if (request.argv[1] === "commands") {
        commandsAttempts += 1;

        if (commandsAttempts === 1) {
          throw new Error("app not ready");
        }

        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "workspace:save\n",
        };
      }

      throw new Error(`Unhandled request: ${request.argv.join(" ")}`);
    });

    const client = createObsidianClient({
      intervalMs: 1,
      timeoutMs: 25,
      transport,
      vault: "dev",
    });

    await expect(client.app.version()).resolves.toBe("1.8.10");
    await expect(client.app.waitUntilReady()).resolves.toBeUndefined();
    await expect(client.app.reload()).resolves.toBeUndefined();
    await expect(client.app.restart()).resolves.toBeUndefined();

    expect(transport.mock.calls.some(([request]) => request.argv[1] === "restart")).toBeTruthy();
    expect(commandsAttempts).toBeGreaterThan(1);
  });

  test("exposes evalJson, evalRaw, metadata, diagnostics, and screenshot helpers", async () => {
    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[1] === "eval") {
        const code = getCodeArg(request.argv);

        if (code.includes("metadataCache?.getFileCache?.(__obsidianE2EFile)")) {
          return {
            argv: request.argv,
            command: request.bin,
            exitCode: 0,
            stderr: "",
            stdout: '{"ok":true,"value":{"frontmatter":{"tags":["daily"]},"headings":[]}}\n',
          };
        }

        if (code.includes('__obsidianE2EMethod=\\"diagnostics\\"')) {
          return {
            argv: request.argv,
            command: request.bin,
            exitCode: 0,
            stderr: "",
            stdout:
              '{"ok":true,"value":{"consoleMessages":[{"args":["hello"],"at":1,"level":"log","text":"hello"}],"notices":[{"at":2,"message":"Saved"}],"runtimeErrors":[{"at":3,"message":"boom","source":"error"}]}}\n',
          };
        }

        if (code.includes('__obsidianE2EMethod=\\"reset\\"')) {
          return {
            argv: request.argv,
            command: request.bin,
            exitCode: 0,
            stderr: "",
            stdout: '{"ok":true,"value":true}\n',
          };
        }

        if (code.includes("__obsidianE2ESerialize")) {
          return {
            argv: request.argv,
            command: request.bin,
            exitCode: 0,
            stderr: "",
            stdout:
              '{"ok":true,"value":{"activeFile":"Inbox/Today.md","values":[1,{"nested":"ok"}]}}\n',
          };
        }

        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "raw\n",
        };
      }

      if (request.argv[1] === "dev:dom") {
        if (request.argv.includes("total")) {
          return {
            argv: request.argv,
            command: request.bin,
            exitCode: 0,
            stderr: "",
            stdout: "3\n",
          };
        }

        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "Files\nSearch\nBookmarks\n",
        };
      }

      if (request.argv[1] === "dev:screenshot") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "",
        };
      }

      throw new Error(`Unhandled request: ${request.argv.join(" ")}`);
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await expect(
      client.dev.evalJson<{ activeFile: string; values: unknown[] }>("code"),
    ).resolves.toEqual({
      activeFile: "Inbox/Today.md",
      values: [1, { nested: "ok" }],
    });
    await expect(client.dev.evalRaw("code")).resolves.toBe("raw");
    await expect(client.metadata.fileCache("Inbox/Today.md")).resolves.toEqual({
      frontmatter: {
        tags: ["daily"],
      },
      headings: [],
    });
    await expect(client.dev.diagnostics()).resolves.toEqual({
      consoleMessages: [{ args: ["hello"], at: 1, level: "log", text: "hello" }],
      notices: [{ at: 2, message: "Saved" }],
      runtimeErrors: [{ at: 3, message: "boom", source: "error" }],
    });
    await expect(client.dev.resetDiagnostics()).resolves.toBeUndefined();
    await expect(
      client.dev.dom({ all: true, selector: ".workspace-tab-header-inner-title", text: true }),
    ).resolves.toEqual(["Files", "Search", "Bookmarks"]);
    await expect(client.dev.dom({ selector: ".workspace-tab", total: true })).resolves.toBe(3);
    await expect(client.dev.screenshot("/tmp/shot.png")).resolves.toBe("/tmp/shot.png");
  });

  test("preserves legacy eval parsing semantics", async () => {
    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[1] !== "eval") {
        throw new Error(`Unhandled request: ${request.argv.join(" ")}`);
      }

      const code = getCodeArg(request.argv);

      if (code === "1 + 1") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "=> 2\n",
        };
      }

      if (code === "raw-value") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: "Inbox/Today.md\n",
        };
      }

      throw new Error(`Unhandled eval request: ${request.argv.join(" ")}`);
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await expect(client.dev.eval<number>("1 + 1")).resolves.toBe(2);
    await expect(client.dev.eval<string>("raw-value")).resolves.toBe("Inbox/Today.md");
  });

  test("raises remote evalJson failures with remote stack details", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: ["vault=dev", "eval"],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout:
        '{"ok":false,"error":{"name":"TypeError","message":"Nope","stack":"TypeError: Nope\\n    at eval"}}\n',
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await expect(client.dev.evalJson("broken()")).rejects.toBeInstanceOf(DevEvalError);
    await expect(client.dev.evalJson("broken()")).rejects.toMatchObject({
      message: expect.stringContaining("Nope"),
      remote: {
        message: "Nope",
        name: "TypeError",
        stack: "TypeError: Nope\n    at eval",
      },
    });
  });

  test("rejects unsupported evalJson values with clear errors", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: ["vault=dev", "eval"],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout:
        '{"ok":false,"error":{"name":"Error","message":"Cannot serialize non-plain object at $.value","stack":"Error: Cannot serialize non-plain object at $.value"}}\n',
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await expect(client.dev.evalJson("unsupported()")).rejects.toMatchObject({
      message: expect.stringContaining("Cannot serialize non-plain object"),
      remote: {
        message: "Cannot serialize non-plain object at $.value",
        name: "Error",
      },
    });
  });

  test("round-trips undefined through evalJson", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: ["vault=dev", "eval"],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout: '{"ok":true,"value":{"__obsidianE2EType":"undefined"}}\n',
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await expect(client.dev.evalJson("undefined")).resolves.toBeUndefined();
  });

  test("provides a first-class sleep helper", async () => {
    const client = createObsidianClient({
      transport: vi.fn<CommandTransport>().mockResolvedValue({
        argv: [],
        command: "obsidian",
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      vault: "dev",
    });

    await expect(client.sleep(5)).resolves.toBeUndefined();
  });

  test("waits for active files and diagnostics", async () => {
    let activeFileAttempts = 0;
    let consoleAttempts = 0;
    let noticeAttempts = 0;
    let runtimeErrorAttempts = 0;

    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[1] !== "eval") {
        throw new Error(`Unhandled request: ${request.argv.join(" ")}`);
      }

      const code = request.argv.find((entry) => entry.startsWith("code=")) ?? "";

      if (code === "code=app.workspace.getActiveFile()?.path ?? null") {
        activeFileAttempts += 1;
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: `${activeFileAttempts > 1 ? "Inbox/Today.md" : "Inbox/Pending.md"}\n`,
        };
      }

      if (code.includes('__obsidianE2EMethod=\\"consoleMessages\\"')) {
        consoleAttempts += 1;
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            value: consoleAttempts > 1 ? [{ args: [], at: 1, level: "log", text: "done" }] : [],
          }),
        };
      }

      if (code.includes('__obsidianE2EMethod=\\"notices\\"')) {
        noticeAttempts += 1;
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            value: noticeAttempts > 1 ? [{ at: 2, message: "Saved" }] : [],
          }),
        };
      }

      if (code.includes('__obsidianE2EMethod=\\"runtimeErrors\\"')) {
        runtimeErrorAttempts += 1;
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            ok: true,
            value: runtimeErrorAttempts > 1 ? [{ at: 3, message: "boom", source: "error" }] : [],
          }),
        };
      }

      throw new Error(`Unhandled eval request: ${request.argv.join(" ")}`);
    });

    const client = createObsidianClient({
      intervalMs: 1,
      timeoutMs: 50,
      transport,
      vault: "dev",
    });

    await expect(client.waitForActiveFile("Inbox/Today.md")).resolves.toBe("Inbox/Today.md");
    await expect(client.waitForConsoleMessage((entry) => entry.text === "done")).resolves.toEqual({
      args: [],
      at: 1,
      level: "log",
      text: "done",
    });
    await expect(client.waitForNotice("Saved")).resolves.toEqual({
      at: 2,
      message: "Saved",
    });
    await expect(client.waitForRuntimeError("boom")).resolves.toEqual({
      at: 3,
      message: "boom",
      source: "error",
    });
  });

  test("passes direct and structured eval code through the spawned transport", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-e2e-client-"));
    const logPath = path.join(tempDir, "argv.log");
    const binPath = path.join(tempDir, "fake-obsidian");

    await writeFile(
      binPath,
      [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.OBSIDIAN_E2E_TEST_LOG, `${JSON.stringify(argv)}\\n`, 'utf8');",
        "const codeArg = argv.find((entry) => entry.startsWith('code=')) ?? '';",
        "const code = codeArg.slice(5);",
        "if (argv[1] !== 'eval') { process.stdout.write(''); process.exit(0); }",
        'if (code.includes(\'__obsidianE2ESerialize\')) { process.stdout.write(\'{"ok":true,"value":{"ok":true,"items":[1,2]}}\\n\'); process.exit(0); }',
        "process.stdout.write('=> 2\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(binPath, 0o755);

    const client = createObsidianClient({
      bin: binPath,
      defaultExecOptions: {
        env: {
          ...process.env,
          OBSIDIAN_E2E_TEST_LOG: logPath,
        },
      },
      vault: "dev",
    });

    await expect(client.dev.eval<number>("1 + 1")).resolves.toBe(2);
    await expect(
      client.dev.evalJson<{ items: number[]; ok: boolean }>("({ ok: true, items: [1, 2] })"),
    ).resolves.toEqual({
      items: [1, 2],
      ok: true,
    });

    const loggedArgv = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);

    expect(loggedArgv).toHaveLength(2);
    expect(loggedArgv.every((argv) => argv[1] === "eval")).toBe(true);
    expect(loggedArgv.map((argv) => getCodeArg(argv)).every((code) => !code.includes("\n"))).toBe(
      true,
    );
  });

  test("exports a reusable exec option merge helper", () => {
    expect(
      mergeExecOptions(
        {
          allowNonZeroExit: true,
          cwd: "/tmp/default",
          env: { BASE: "1" },
          timeoutMs: 100,
        },
        {
          env: { EXTRA: "2" },
          timeoutMs: 50,
        },
      ),
    ).toEqual({
      allowNonZeroExit: true,
      cwd: "/tmp/default",
      env: {
        BASE: "1",
        EXTRA: "2",
      },
      timeoutMs: 50,
    });
  });

  test("parses tab listings into structured summaries", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: ["vault=dev", "tabs", "ids"],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout: ["[markdown] Scratchpad\t0aa19b408796c178", "[search] Search\t3cf5b3d2650e6876"].join(
        "\n",
      ),
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await expect(client.tabs()).resolves.toEqual([
      {
        id: "0aa19b408796c178",
        title: "Scratchpad",
        viewType: "markdown",
      },
      {
        id: "3cf5b3d2650e6876",
        title: "Search",
        viewType: "search",
      },
    ]);
  });

  test("parses workspace trees into nested nodes", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: ["vault=dev", "workspace", "ids"],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout: [
        "main (788f2fbccb2b2bd8)",
        "└── tabs (fd6cc83bba7021a1)",
        "    └── [markdown] Hermes Agent on revos (9f9ab6a17f3ea4dd)",
        "left (6e16f7fccad911e0)",
        "└── tabs (ef8b61f48870e81e)",
        "    ├── [file-explorer] Files (819c55e1babe790c)",
        "    └── [search] Search (3cf5b3d2650e6876)",
      ].join("\n"),
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await expect(client.workspace()).resolves.toEqual([
      {
        children: [
          {
            children: [
              {
                children: [],
                id: "9f9ab6a17f3ea4dd",
                label: "Hermes Agent on revos",
                title: "Hermes Agent on revos",
                viewType: "markdown",
              },
            ],
            id: "fd6cc83bba7021a1",
            label: "tabs",
          },
        ],
        id: "788f2fbccb2b2bd8",
        label: "main",
      },
      {
        children: [
          {
            children: [
              {
                children: [],
                id: "819c55e1babe790c",
                label: "Files",
                title: "Files",
                viewType: "file-explorer",
              },
              {
                children: [],
                id: "3cf5b3d2650e6876",
                label: "Search",
                title: "Search",
                viewType: "search",
              },
            ],
            id: "ef8b61f48870e81e",
            label: "tabs",
          },
        ],
        id: "6e16f7fccad911e0",
        label: "left",
      },
    ]);
  });

  test("opens notes and tabs with the expected argv", async () => {
    const transport = vi.fn<CommandTransport>().mockResolvedValue({
      argv: [],
      command: "obsidian",
      exitCode: 0,
      stderr: "",
      stdout: "",
    });

    const client = createObsidianClient({
      transport,
      vault: "dev",
    });

    await client.open({
      newTab: true,
      path: "Inbox/Today.md",
    });
    await client.openTab({
      file: "Inbox/Today.md",
      group: "fd6cc83bba7021a1",
      view: "markdown",
    });

    expect(transport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        argv: ["vault=dev", "open", "newtab", "path=Inbox/Today.md"],
      }),
    );
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        argv: [
          "vault=dev",
          "tab:open",
          "file=Inbox/Today.md",
          "group=fd6cc83bba7021a1",
          "view=markdown",
        ],
      }),
    );
  });

  function getCodeArg(argv: string[]): string {
    return argv.find((entry) => entry.startsWith("code="))?.slice(5) ?? "";
  }
});
