import { describe, expect, it } from "vite-plus/test";

import { createObsidianClient } from "../../src/core/client";
import { DevEvalError } from "../../src/core/errors";
import { buildEvalJsonAsyncCode, runEvalJsonAsync } from "../../src/dev/eval-json";
import { createExecResult } from "../helpers/create-exec-result";
import type { CommandTransport, ObsidianDevHandle } from "../../src/core/types";

function stubDev(
  evalRaw: (code: string) => Promise<string> | string,
): Pick<ObsidianDevHandle, "evalRaw"> {
  return {
    async evalRaw(code) {
      return evalRaw(code);
    },
  };
}

describe("buildEvalJsonAsyncCode", () => {
  it("emits an async IIFE that awaits the evaluated code", () => {
    const code = buildEvalJsonAsyncCode("app.foo()");

    expect(code.startsWith("(async()=>{")).toBe(true);
    expect(code).toContain("await (0,eval)(__obsidianE2ECode)");
    // Reuses the shared serializer/decoder envelope.
    expect(code).toContain("__obsidianE2ESerialize");
    expect(code).toContain("JSON.stringify({ok:true,value:");
  });
});

describe("runEvalJsonAsync", () => {
  it("resolves the awaited value from a success envelope", async () => {
    const dev = stubDev(() => JSON.stringify({ ok: true, value: { count: 2, items: [1, 2] } }));

    await expect(runEvalJsonAsync(dev, "await load()")).resolves.toEqual({
      count: 2,
      items: [1, 2],
    });
  });

  it("decodes the undefined sentinel", async () => {
    const dev = stubDev(() =>
      JSON.stringify({ ok: true, value: { done: { __obsidianE2EType: "undefined" } } }),
    );

    await expect(runEvalJsonAsync(dev, "await noop()")).resolves.toEqual({ done: undefined });
  });

  it("surfaces a thrown error with message and remote stack", async () => {
    const dev = stubDev(() =>
      JSON.stringify({
        ok: false,
        error: { message: "boom", name: "TypeError", stack: "TypeError: boom\n    at eval" },
      }),
    );

    const error = await runEvalJsonAsync(dev, "await fail()").catch((thrown) => thrown);

    expect(error).toBeInstanceOf(DevEvalError);
    expect((error as DevEvalError).message).toBe("Failed to evaluate Obsidian code: boom");
    expect((error as DevEvalError).remote.stack).toBe("TypeError: boom\n    at eval");
    expect((error as DevEvalError).stack).toContain("TypeError: boom\n    at eval");
  });
});

describe("obsidian.dev.evalJsonAsync", () => {
  it("passes the async builder output through evalRaw and decodes the envelope", async () => {
    const evalCodes: string[] = [];
    const transport: CommandTransport = async (request) => {
      if (request.argv[0] === "--help") {
        return createExecResult(request.bin, request.argv, "usage\n");
      }

      const [, command, ...rest] = request.argv;
      const args = Object.fromEntries(
        rest
          .filter((entry) => entry.includes("="))
          .map((entry) => {
            const [key, ...value] = entry.split("=");
            return [key, value.join("=")];
          }),
      );

      if (command === "vault" && args.info === "path") {
        return createExecResult(request.bin, request.argv, "/tmp/vault\n");
      }

      if (command === "eval") {
        evalCodes.push(args.code ?? "");
        return createExecResult(
          request.bin,
          request.argv,
          `${JSON.stringify({ ok: true, value: "ready" })}\n`,
        );
      }

      throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
    };

    const obsidian = createObsidianClient({ transport, vault: "dev" });

    await expect(
      obsidian.dev.evalJsonAsync<string>("await Promise.resolve('ready')"),
    ).resolves.toBe("ready");
    expect(evalCodes).toHaveLength(1);
    expect(evalCodes[0]).toContain("await (0,eval)(__obsidianE2ECode)");
  });
});
