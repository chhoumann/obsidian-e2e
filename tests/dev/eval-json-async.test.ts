import { afterEach, describe, expect, it } from "vite-plus/test";

import { createObsidianClient } from "../../src/core/client";
import {
  DevEvalAsyncError,
  DevEvalError,
  ObsidianCommandError,
  ObsidianCommandTimeoutError,
} from "../../src/core/errors";
import {
  buildEvalJsonAsyncCleanupCode,
  buildEvalJsonAsyncKickoffCode,
  buildEvalJsonAsyncPollCode,
  createEvalJsonFrame,
  parseEvalJsonEnvelope,
  runEvalJsonAsync,
} from "../../src/dev/eval-json";
import { createExecResult, frameEvalPayload } from "../helpers/create-exec-result";
import type { CommandTransport, ExecOptions, ObsidianDevHandle } from "../../src/core/types";

const REGISTRY = "__obsidianE2EAsyncEvals";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[REGISTRY];
});

function registryEntries(): Record<string, { state: string }> {
  return ((globalThis as Record<string, unknown>)[REGISTRY] ?? {}) as Record<
    string,
    { state: string }
  >;
}

type CommandBehavior = "drop-reply" | "fail-undelivered" | undefined;

interface EmulatedCommand {
  behavior: CommandBehavior;
  code: string;
  execOptions: ExecOptions;
  index: number;
}

/**
 * Emulates the in-app side of the protocol by actually executing the generated
 * eval code in this process, so kickoff/poll/cleanup operate on a real
 * `globalThis` registry. `drop-reply` executes the command and then throws
 * (delivered, reply lost); `fail-undelivered` throws the CLI connect failure
 * without executing.
 */
function createInAppEmulator(
  onCommand: (command: Omit<EmulatedCommand, "behavior">) => CommandBehavior = () => undefined,
) {
  const commands: EmulatedCommand[] = [];
  const dev: Pick<ObsidianDevHandle, "evalRaw"> = {
    async evalRaw(code, execOptions: ExecOptions = {}) {
      const command = { code, execOptions, index: commands.length };
      const behavior = onCommand(command);
      commands.push({ ...command, behavior });

      if (behavior === "fail-undelivered") {
        throw new ObsidianCommandError("Obsidian command failed with exit code 1: obsidian eval", {
          argv: ["eval"],
          command: "obsidian",
          exitCode: 1,
          stderr:
            "The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.\n",
          stdout: "",
        });
      }

      const output = (await (0, eval)(code)) as string;

      if (behavior === "drop-reply") {
        throw new ObsidianCommandTimeoutError("obsidian", ["eval"], 10);
      }

      return output;
    },
  };

  return { commands, dev };
}

describe("buildEvalJsonAsyncKickoffCode", () => {
  it("registers the nonce, starts the awaited code, and returns immediately", () => {
    const frame = createEvalJsonFrame();
    const code = buildEvalJsonAsyncKickoffCode("app.foo()", frame, "nonce-1");

    expect(code).toContain(`globalThis.${REGISTRY}`);
    expect(code).toContain(JSON.stringify("nonce-1"));
    expect(code).toContain("{state:'pending'}");
    expect(code).toContain("await (0,eval)(__obsidianE2ECode)");
    expect(code).toContain(JSON.stringify(frame.begin));
    expect(code).toContain(JSON.stringify(frame.end));
  });

  it("wraps the caller code so a top-level await parses", () => {
    // Indirect eval treats its argument as a script, where a bare `await` would
    // be a SyntaxError; the wrapper turns it into an async arrow expression body.
    const code = buildEvalJsonAsyncKickoffCode("await load()", createEvalJsonFrame(), "n");

    expect(code).toContain(JSON.stringify("(async()=>(await load()))()"));
  });
});

describe("runEvalJsonAsync", () => {
  it("resolves the awaited value and cleans up the registry entry", async () => {
    const { commands, dev } = createInAppEmulator();

    await expect(
      runEvalJsonAsync(dev, "await Promise.resolve({ count: 2, items: [1, 2] })"),
    ).resolves.toEqual({ count: 2, items: [1, 2] });

    // kickoff + poll + cleanup, every command a short read/write.
    expect(commands.length).toBeGreaterThanOrEqual(3);
    expect(commands.at(-1)?.code).toContain("delete registry[");
    expect(Object.keys(registryEntries())).toHaveLength(0);
  });

  it("resolves an undefined result through the sentinel", async () => {
    const { dev } = createInAppEmulator();

    await expect(runEvalJsonAsync(dev, "await Promise.resolve(undefined)")).resolves.toBe(
      undefined,
    );
  });

  it("surfaces a rejected promise as a DevEvalError with the remote stack", async () => {
    const { dev } = createInAppEmulator();

    const error = await runEvalJsonAsync(dev, "Promise.reject(new TypeError('nope'))").catch(
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(DevEvalError);
    expect((error as DevEvalError).message).toBe("Failed to evaluate Obsidian code: nope");
    expect((error as DevEvalError).remote.name).toBe("TypeError");
    expect((error as DevEvalError).remote.stack).toContain("TypeError: nope");
  });

  it("stores a serialization failure as an error envelope at completion time", async () => {
    const { dev } = createInAppEmulator();

    await expect(runEvalJsonAsync(dev, "Promise.resolve(() => 1)")).rejects.toThrowError(
      /Cannot serialize function/,
    );
  });

  it("recovers the result when the kickoff reply is lost (delivered, reply dropped)", async () => {
    (globalThis as Record<string, unknown>).__runs = 0;
    const { dev } = createInAppEmulator(({ index }) => (index === 0 ? "drop-reply" : undefined));

    await expect(
      runEvalJsonAsync(dev, "(globalThis.__runs++, await Promise.resolve('recovered'))"),
    ).resolves.toBe("recovered");
    expect((globalThis as Record<string, unknown>).__runs).toBe(1);
    delete (globalThis as Record<string, unknown>).__runs;
  });

  it("recovers when a poll reply is lost", async () => {
    const { dev } = createInAppEmulator(({ index }) => (index === 1 ? "drop-reply" : undefined));

    await expect(runEvalJsonAsync(dev, "await Promise.resolve('polled')")).resolves.toBe("polled");
  });

  it("fails with reason 'still-pending' when the promise never settles", async () => {
    const { dev } = createInAppEmulator();

    const error = await runEvalJsonAsync(dev, "new Promise(() => {})", {
      timeoutMs: 450,
    }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(DevEvalAsyncError);
    expect((error as DevEvalAsyncError).reason).toBe("still-pending");
    // The operation is still registered; the message names the nonce for inspection.
    expect((error as DevEvalAsyncError).message).toContain((error as DevEvalAsyncError).nonce);
  });

  it("fails with reason 'context-reset' when the registry vanishes after confirmation", async () => {
    const { dev } = createInAppEmulator(({ index }) => {
      if (index === 1) {
        // Simulate an app/vault reload wiping the renderer between commands.
        delete (globalThis as Record<string, unknown>)[REGISTRY];
      }
      return undefined;
    });

    const error = await runEvalJsonAsync(dev, "new Promise(() => {})").catch((thrown) => thrown);

    expect(error).toBeInstanceOf(DevEvalAsyncError);
    expect((error as DevEvalAsyncError).reason).toBe("context-reset");
  });

  it("fails with reason 'ambiguous-delivery' and never reruns when kickoff delivery is unknown", async () => {
    (globalThis as Record<string, unknown>).__runs = 0;
    // The kickoff times out without ever executing; polls legitimately find nothing.
    const dev: Pick<ObsidianDevHandle, "evalRaw"> = {
      async evalRaw(code) {
        if (code.includes("{state:'pending'}")) {
          throw new ObsidianCommandTimeoutError("obsidian", ["eval"], 10);
        }
        return (0, eval)(code) as string;
      },
    };

    const error = await runEvalJsonAsync(dev, "globalThis.__runs++", { timeoutMs: 450 }).catch(
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(DevEvalAsyncError);
    expect((error as DevEvalAsyncError).reason).toBe("ambiguous-delivery");
    expect((globalThis as Record<string, unknown>).__runs).toBe(0);
    delete (globalThis as Record<string, unknown>).__runs;
  });

  it("reports 'ambiguous-delivery' with the connect failure as cause when the CLI never connects", async () => {
    (globalThis as Record<string, unknown>).__runs = 0;
    const { dev } = createInAppEmulator(() => "fail-undelivered");

    const error = await runEvalJsonAsync(dev, "globalThis.__runs++", { timeoutMs: 350 }).catch(
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(DevEvalAsyncError);
    expect((error as DevEvalAsyncError).reason).toBe("ambiguous-delivery");
    expect((error as DevEvalAsyncError).message).toContain(
      "kickoff command failed or its reply was lost",
    );
    expect((error as DevEvalAsyncError).causeError).toBeInstanceOf(ObsidianCommandError);
    // The kickoff is never resent, so the code cannot have run.
    expect((globalThis as Record<string, unknown>).__runs).toBe(0);
    delete (globalThis as Record<string, unknown>).__runs;
  });

  it("parses kickoff and poll replies surrounded by plugin log noise", async () => {
    const emulator = createInAppEmulator();
    const dev: Pick<ObsidianDevHandle, "evalRaw"> = {
      async evalRaw(code, execOptions) {
        const output = await emulator.dev.evalRaw(code, execOptions);
        return `QuickAdd: (LOG) Applying template\n${output}\nMetaEdit: trailing logger output`;
      },
    };

    await expect(
      runEvalJsonAsync(dev, "await Promise.resolve({ path: 'note.md' })"),
    ).resolves.toEqual({ path: "note.md" });
  });
});

describe("buildEvalJsonAsyncPollCode / buildEvalJsonAsyncCleanupCode", () => {
  it("reads and deletes exactly the nonce entry", () => {
    (globalThis as Record<string, unknown>)[REGISTRY] = {
      keep: { state: "pending" },
      mine: { envelope: { ok: true, value: 1 }, state: "done" },
    };

    expect((0, eval)(buildEvalJsonAsyncPollCode("mine"))).toEqual({
      envelope: { ok: true, value: 1 },
      state: "done",
    });
    expect((0, eval)(buildEvalJsonAsyncPollCode("missing"))).toBe(null);

    expect((0, eval)(buildEvalJsonAsyncCleanupCode("mine"))).toBe(true);
    expect(Object.keys(registryEntries())).toEqual(["keep"]);
  });
});

describe("obsidian.dev.evalJsonAsync", () => {
  it("runs the kickoff-and-poll protocol through the client transport", async () => {
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
        const output = (await (0, eval)(code)) as string;
        return createExecResult(request.bin, request.argv, `${output}\n`);
      }

      throw new Error(`Unhandled transport request: ${request.argv.join(" ")}`);
    };

    const obsidian = createObsidianClient({ transport, vault: "dev" });

    await expect(
      obsidian.dev.evalJsonAsync<string>("await Promise.resolve('ready')"),
    ).resolves.toBe("ready");

    // kickoff + at least one poll + cleanup - never a single held command.
    expect(evalCodes.length).toBeGreaterThanOrEqual(3);
    expect(evalCodes[0]).toContain("await (0,eval)(__obsidianE2ECode)");
    expect(evalCodes[1]).toContain(REGISTRY);
  });

  it("propagates default env/cwd to every protocol command and honors the default timeout as deadline", async () => {
    const seen: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }[] = [];
    const transport: CommandTransport = async (request) => {
      const [, command, ...rest] = request.argv;
      if (command === "eval") {
        seen.push({ cwd: request.cwd, env: request.env, timeoutMs: request.timeoutMs });
        const code = rest.find((entry) => entry.startsWith("code="))?.slice(5) ?? "";
        const output = (await (0, eval)(code)) as string;
        return createExecResult(request.bin, request.argv, `${output}\n`);
      }
      return createExecResult(request.bin, request.argv, "");
    };

    const obsidian = createObsidianClient({
      defaultExecOptions: { cwd: "/work", env: { HOME: "/private-home" }, timeoutMs: 700 },
      transport,
      vault: "dev",
    });

    const error = await obsidian.dev
      .evalJsonAsync("new Promise(() => {})")
      .catch((thrown) => thrown);

    // The default timeoutMs bounds the whole protocol, not one command.
    expect(error).toBeInstanceOf(DevEvalAsyncError);
    expect((error as DevEvalAsyncError).reason).toBe("still-pending");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const command of seen) {
      expect(command.cwd).toBe("/work");
      expect(command.env?.HOME).toBe("/private-home");
      expect(command.timeoutMs).toBeLessThanOrEqual(700);
    }
  });
});

describe("frameEvalPayload compatibility", () => {
  it("still frames synchronous evalJson payloads for stubbed transports", () => {
    const frame = createEvalJsonFrame();
    const framed = frameEvalPayload(
      `prefix ${frame.begin} suffix`,
      JSON.stringify({ ok: true, value: 1 }),
    );

    expect(parseEvalJsonEnvelope<number>(framed, frame)).toBe(1);
  });
});
