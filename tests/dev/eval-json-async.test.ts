import { describe, expect, it } from "vite-plus/test";

import { createObsidianClient } from "../../src/core/client";
import { DevEvalError } from "../../src/core/errors";
import {
  buildEvalJsonAsyncCode,
  createEvalJsonFrame,
  parseEvalJsonEnvelope,
  runEvalJsonAsync,
} from "../../src/dev/eval-json";
import { createExecResult, frameEvalPayload } from "../helpers/create-exec-result";
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
    const code = buildEvalJsonAsyncCode("app.foo()", createEvalJsonFrame());

    expect(code.startsWith("(async()=>{")).toBe(true);
    expect(code).toContain("await (0,eval)(__obsidianE2ECode)");
    // Reuses the shared serializer/decoder envelope.
    expect(code).toContain("__obsidianE2ESerialize");
    expect(code).toContain("JSON.stringify({ok:true,value:");
  });

  it("wraps the caller code so a top-level await parses", () => {
    // Indirect eval treats its argument as a script, where a bare `await` would
    // be a SyntaxError; the wrapper turns it into an async arrow expression body.
    const code = buildEvalJsonAsyncCode("await load()", createEvalJsonFrame());

    expect(code).toContain(JSON.stringify("(async()=>(await load()))()"));
  });

  it("embeds the per-call frame markers around the envelope", () => {
    const frame = createEvalJsonFrame();
    const code = buildEvalJsonAsyncCode("app.foo()", frame);

    expect(code).toContain(JSON.stringify(frame.begin));
    expect(code).toContain(JSON.stringify(frame.end));
  });
});

// Exercises the generated code in a real JS engine (the stubbed transport tests
// above never execute it) so the top-level-await path cannot regress silently.
describe("buildEvalJsonAsyncCode executed", () => {
  const evalGenerated = async <T>(userCode: string): Promise<T> => {
    const frame = createEvalJsonFrame();
    const raw = await (0, eval)(buildEvalJsonAsyncCode(userCode, frame));
    return parseEvalJsonEnvelope<T>(raw, frame);
  };

  it("runs a top-level-await body and returns the resolved value", async () => {
    await expect(evalGenerated("await Promise.resolve({ count: 2 })")).resolves.toEqual({
      count: 2,
    });
  });

  it("runs a promise-returning expression", async () => {
    await expect(evalGenerated("Promise.resolve('ready')")).resolves.toBe("ready");
  });

  it("runs an async IIFE expression", async () => {
    await expect(evalGenerated("(async () => 'done')()")).resolves.toBe("done");
  });

  it("surfaces a rejected promise as a DevEvalError", async () => {
    const error = await evalGenerated("Promise.reject(new TypeError('nope'))").catch(
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(DevEvalError);
    expect((error as DevEvalError).message).toBe("Failed to evaluate Obsidian code: nope");
  });
});

describe("runEvalJsonAsync", () => {
  it("resolves the awaited value from a success envelope", async () => {
    const dev = stubDev((code) =>
      frameEvalPayload(code, JSON.stringify({ ok: true, value: { count: 2, items: [1, 2] } })),
    );

    await expect(runEvalJsonAsync(dev, "await load()")).resolves.toEqual({
      count: 2,
      items: [1, 2],
    });
  });

  it("decodes the undefined sentinel", async () => {
    const dev = stubDev((code) =>
      frameEvalPayload(
        code,
        JSON.stringify({ ok: true, value: { done: { __obsidianE2EType: "undefined" } } }),
      ),
    );

    await expect(runEvalJsonAsync(dev, "await noop()")).resolves.toEqual({ done: undefined });
  });

  it("surfaces a thrown error with message and remote stack", async () => {
    const dev = stubDev((code) =>
      frameEvalPayload(
        code,
        JSON.stringify({
          ok: false,
          error: { message: "boom", name: "TypeError", stack: "TypeError: boom\n    at eval" },
        }),
      ),
    );

    const error = await runEvalJsonAsync(dev, "await fail()").catch((thrown) => thrown);

    expect(error).toBeInstanceOf(DevEvalError);
    expect((error as DevEvalError).message).toBe("Failed to evaluate Obsidian code: boom");
    expect((error as DevEvalError).remote.stack).toBe("TypeError: boom\n    at eval");
    expect((error as DevEvalError).stack).toContain("TypeError: boom\n    at eval");
  });
});

// Regression for https://github.com/chhoumann/obsidian-e2e/issues/18: the eval
// channel is shared with whatever the plugin prints while the evaluated code
// runs (e.g. "QuickAdd: ..." notices), which used to corrupt the JSON envelope.
describe("runEvalJsonAsync with plugin output on the eval channel", () => {
  it("parses the envelope surrounded by plugin log noise", async () => {
    const dev = stubDev((code) =>
      [
        "QuickAdd: (LOG) Applying template to active file",
        frameEvalPayload(code, JSON.stringify({ ok: true, value: { path: "note.md" } })),
        "MetaEdit: trailing logger output",
      ].join("\n"),
    );

    await expect(runEvalJsonAsync(dev, "await apply()")).resolves.toEqual({ path: "note.md" });
  });

  it("parses an error envelope surrounded by plugin log noise", async () => {
    const dev = stubDev((code) =>
      [
        "QuickAdd: (ERROR) template failed",
        frameEvalPayload(
          code,
          JSON.stringify({ ok: false, error: { message: "boom", name: "Error" } }),
        ),
      ].join("\n"),
    );

    await expect(runEvalJsonAsync(dev, "await fail()")).rejects.toThrowError(
      "Failed to evaluate Obsidian code: boom",
    );
  });

  it("parses when the serialized value itself contains the frame marker text", async () => {
    const frame = createEvalJsonFrame();
    const value = { echo: `${frame.begin} inside ${frame.end}` };
    const raw = `noise\n${frame.begin}${JSON.stringify({ ok: true, value })}${frame.end}\n`;

    expect(parseEvalJsonEnvelope(raw, frame)).toEqual(value);
  });

  it("reports a clear error when the framed envelope is missing entirely", async () => {
    const dev = stubDev(() => "QuickAdd: only log output, no envelope");

    await expect(runEvalJsonAsync(dev, "await apply()")).rejects.toThrowError(
      /did not contain the framed JSON result envelope/,
    );
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
        const code = args.code ?? "";
        evalCodes.push(code);
        return createExecResult(
          request.bin,
          request.argv,
          `${frameEvalPayload(code, JSON.stringify({ ok: true, value: "ready" }))}\n`,
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
