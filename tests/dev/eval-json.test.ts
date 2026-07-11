import { describe, expect, it } from "vite-plus/test";

import { DevEvalError } from "../../src/core/errors";
import {
  buildEvalJsonCode,
  createEvalJsonFrame,
  parseEvalJsonEnvelope,
  runEvalJson,
} from "../../src/dev/eval-json";
import { frameEvalPayload } from "../helpers/create-exec-result";
import type { ObsidianDevHandle } from "../../src/core/types";

function stubDev(
  evalRaw: (code: string) => Promise<string> | string,
): Pick<ObsidianDevHandle, "evalRaw"> {
  return {
    async evalRaw(code) {
      return evalRaw(code);
    },
  };
}

// Executes the generated code in a real JS engine so the framed envelope the
// builder emits and the parser's extraction stay in lockstep.
describe("buildEvalJsonCode executed", () => {
  const evalGenerated = <T>(userCode: string): T => {
    const frame = createEvalJsonFrame();
    const raw = (0, eval)(buildEvalJsonCode(userCode, frame)) as string;
    return parseEvalJsonEnvelope<T>(raw, frame);
  };

  it("frames the success envelope and round-trips the value", () => {
    expect(evalGenerated("({ count: 2, items: [1, 2] })")).toEqual({ count: 2, items: [1, 2] });
  });

  it("frames the failure envelope thrown by the evaluated code", () => {
    let thrown: unknown;
    try {
      evalGenerated("(() => { throw new TypeError('nope'); })()");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DevEvalError);
    expect((thrown as DevEvalError).message).toBe("Failed to evaluate Obsidian code: nope");
  });
});

// Regression for https://github.com/chhoumann/obsidian-e2e/issues/18 on the
// synchronous path: plugin output on the shared eval channel must not corrupt
// the envelope.
describe("runEvalJson with plugin output on the eval channel", () => {
  it("parses the envelope surrounded by plugin log noise", async () => {
    const dev = stubDev((code) =>
      [
        "MetaEdit: (LOG) updating property",
        frameEvalPayload(code, JSON.stringify({ ok: true, value: 42 })),
        "MetaEdit: done",
      ].join("\n"),
    );

    await expect(runEvalJson(dev, "compute()")).resolves.toBe(42);
  });

  it("parses an error envelope surrounded by plugin log noise", async () => {
    const dev = stubDev((code) =>
      [
        "QuickAdd: (ERROR) something broke",
        frameEvalPayload(
          code,
          JSON.stringify({ ok: false, error: { message: "boom", name: "Error" } }),
        ),
      ].join("\n"),
    );

    await expect(runEvalJson(dev, "fail()")).rejects.toThrowError(
      "Failed to evaluate Obsidian code: boom",
    );
  });

  it("reports a clear error when the framed envelope is missing entirely", async () => {
    const dev = stubDev(() => "MetaEdit: only log output, no envelope");

    await expect(runEvalJson(dev, "compute()")).rejects.toThrowError(
      /did not contain the framed JSON result envelope/,
    );
  });
});
