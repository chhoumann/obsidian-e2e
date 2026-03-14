import { describe, expect, test, vi } from "vite-plus/test";

import { createObsidianClient } from "../../src/core/client";
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

  test("exposes developer eval, dom, and screenshot helpers", async () => {
    const transport = vi.fn<CommandTransport>().mockImplementation(async (request) => {
      if (request.argv[1] === "eval") {
        return {
          argv: request.argv,
          command: request.bin,
          exitCode: 0,
          stderr: "",
          stdout: '=> {"activeFile":"Inbox/Today.md"}\n',
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

    await expect(client.dev.eval<{ activeFile: string }>("code")).resolves.toEqual({
      activeFile: "Inbox/Today.md",
    });
    await expect(
      client.dev.dom({ all: true, selector: ".workspace-tab-header-inner-title", text: true }),
    ).resolves.toEqual(["Files", "Search", "Bookmarks"]);
    await expect(client.dev.dom({ selector: ".workspace-tab", total: true })).resolves.toBe(3);
    await expect(client.dev.screenshot("/tmp/shot.png")).resolves.toBe("/tmp/shot.png");
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
});
