import { describe, expect, test, vi } from "vite-plus/test";

import { createObsidianClient } from "../../src/core/client";
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
});
