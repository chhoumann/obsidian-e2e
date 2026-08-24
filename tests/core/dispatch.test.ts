import { afterEach, describe, expect, it } from "vite-plus/test";

import { createObsidianClient } from "../../src/core/client";
import {
  DISPATCH_COMMAND,
  buildDispatchShimCode,
  createDispatchState,
  dispatchPollDelayMs,
  isUnsupportedCached,
  parseDispatchEnvelope,
  runRecoverableExec,
} from "../../src/core/dispatch";
import {
  ObsidianCommandDispatchError,
  ObsidianCommandError,
  ObsidianCommandTimeoutError,
} from "../../src/core/errors";
import { createExecResult } from "../helpers/create-exec-result";
import { sleep } from "../../src/core/wait";
import type { CommandTransport, ExecuteRequest } from "../../src/core/types";

const SHIM_GLOBAL = "__obsidianE2EDispatch";

type MutableGlobal = Record<string, unknown>;

afterEach(() => {
  const globals = globalThis as MutableGlobal;
  delete globals[SHIM_GLOBAL];
  delete globals.handleCli;
  delete globals.window;
});

type RequestBehavior =
  | "delay-request"
  | "drop-reply"
  | "fail-exit"
  | "frame-disposed"
  | "hang"
  | "timeout"
  | undefined;

type CommandHandler = (flags: Record<string, string>) => unknown;

/**
 * Emulates the whole in-app side of the protocol by actually executing the
 * generated shim/install/poll code in this process: `window.handleCli` is a
 * miniature Obsidian dispatcher over `handlers` (string throws and all), the
 * transport serves `eval` commands by evaluating their code against the real
 * `globalThis`, and every other command is relayed through the current
 * `window.handleCli` exactly like Obsidian's main process does. Behaviors
 * model the observed transport failures: `drop-reply` executes the command and
 * then throws (delivered, reply lost); `delay-request` queues the execution
 * for a later `flushDelayed()` and throws (request stuck in the bridge);
 * `timeout`/`fail-exit` fail without executing.
 */
function createDispatchHarness(handlers: Record<string, CommandHandler>) {
  const globals = globalThis as MutableGlobal;
  globals.window = globalThis;
  const realHandleCli = async (argv: string[]) => {
    const [name = "", ...tokens] = argv;
    const handler = handlers[name];

    if (!handler) {
      throw `Command "${name}" not found. It may require a plugin to be enabled.`;
    }

    const flags: Record<string, string> = {};
    for (const token of tokens) {
      const separator = token.indexOf("=");
      if (separator === -1) {
        flags[token] = "true";
      } else {
        flags[token.slice(0, separator)] = token.slice(separator + 1);
      }
    }

    return handler(flags);
  };
  globals.handleCli = realHandleCli;

  const delayed: Array<() => Promise<string>> = [];
  const dispatchReplies: string[] = [];
  const requests: string[][] = [];
  let behaviorFor: (request: ExecuteRequest) => RequestBehavior = () => undefined;

  const serveThroughHandleCli = async (command: string, tokens: string[]): Promise<string> => {
    // Fall back to the unwrapped dispatcher when a test removed
    // window.handleCli to emulate an app without shim support.
    const handleCli = ((globals.window as MutableGlobal).handleCli ?? realHandleCli) as (
      argv: string[],
    ) => Promise<unknown>;
    try {
      const value = (await handleCli([command, ...tokens])) as string | null | undefined;
      // Mirrors main's `d && b(d)`: falsy resolutions write nothing.
      return value ? String(value) : "";
    } catch (error) {
      return typeof error === "string" ? `Error: ${error}` : String(error);
    }
  };

  const transport: CommandTransport = async (request) => {
    requests.push(request.argv);
    const behavior = behaviorFor(request);
    const [, command = "", ...tokens] = request.argv;

    if (behavior === "timeout") {
      throw new ObsidianCommandTimeoutError(request.bin, request.argv, request.timeoutMs ?? 0);
    }

    if (behavior === "hang") {
      return new Promise(() => {});
    }

    if (behavior === "fail-exit") {
      throw new ObsidianCommandError(`Obsidian command failed with exit code 1: ${request.bin}`, {
        ...createExecResult(request.bin, request.argv, ""),
        exitCode: 1,
      });
    }

    if (command === "eval") {
      const code = (tokens[0] ?? "").slice("code=".length);
      const output = (await (0, eval)(code)) as string;
      return createExecResult(request.bin, request.argv, output);
    }

    if (behavior === "delay-request") {
      delayed.push(() => serveThroughHandleCli(command, tokens));
      throw new ObsidianCommandTimeoutError(request.bin, request.argv, request.timeoutMs ?? 0);
    }

    if (behavior === "frame-disposed") {
      // The renderer tore down mid-request: the command may or may not have
      // dispatched, and Obsidian's main process converts the rejected
      // executeJavaScript into a served string reply at exit 0.
      return createExecResult(
        request.bin,
        request.argv,
        "Error: Render frame was disposed before WebFrameMain could be accessed\n",
      );
    }

    const served = serveThroughHandleCli(command, tokens);

    if (behavior === "drop-reply") {
      // Delivered but the reply is lost: the command keeps running in-app
      // while the CLI process dies, exactly like the real transport kill.
      await Promise.race([served.catch(() => ""), sleep(5)]);
      throw new ObsidianCommandTimeoutError(request.bin, request.argv, request.timeoutMs ?? 0);
    }

    const output = await served;
    if (command === DISPATCH_COMMAND) {
      dispatchReplies.push(output);
    }

    return createExecResult(request.bin, request.argv, output ? `${output}\n` : "");
  };

  return {
    createClient: (recoverable = true) =>
      createObsidianClient({
        defaultExecOptions: { recoverable },
        transport,
        vault: "test",
      }),
    delayed,
    dispatchReplies,
    flushDelayed: async () => {
      const pending = delayed.splice(0);
      return Promise.all(pending.map((fire) => fire()));
    },
    realHandleCli,
    requests,
    setBehavior: (next: (request: ExecuteRequest) => RequestBehavior) => {
      behaviorFor = next;
    },
    transport,
  };
}

function dispatchRequests(requests: string[][]): string[][] {
  return requests.filter((argv) => argv[1] === DISPATCH_COMMAND);
}

function installRequests(requests: string[][]): string[][] {
  return requests.filter(
    (argv) => argv[1] === "eval" && (argv[2] ?? "").includes("window.handleCli"),
  );
}

describe("dispatch protocol helpers", () => {
  it("parses pending and stale envelopes without rejecting extra keys", () => {
    expect(
      parseDispatchEnvelope(
        JSON.stringify({ installId: "gen-1", reply: "ignored", state: "pending", extra: true }),
      ),
    ).toEqual({ installId: "gen-1", state: "pending" });
    expect(
      parseDispatchEnvelope(
        JSON.stringify({ installId: "gen-1", reply: "ignored", state: "stale", extra: true }),
      ),
    ).toEqual({ installId: "gen-1", state: "stale" });
    expect(parseDispatchEnvelope(JSON.stringify({ installId: "gen-1", state: "done" }))).toBeNull();
    expect(
      parseDispatchEnvelope(JSON.stringify({ installId: "gen-1", reply: 42, state: "done" })),
    ).toBeNull();
  });

  it("backs polls off from immediate to one second", () => {
    expect(
      Array.from({ length: 7 }, (_, completedPolls) => dispatchPollDelayMs(completedPolls)),
    ).toEqual([0, 100, 200, 400, 800, 1_000, 1_000]);
  });

  it("expires unsupported capability cache entries after one minute", () => {
    const state = createDispatchState();
    state.unsupportedAt = 1_000;

    expect(isUnsupportedCached(state, 60_999)).toBe(true);
    expect(isUnsupportedCached(state, 61_000)).toBe(false);
  });
});

describe("runRecoverableExec via client.exec", () => {
  it("dispatches through the shim and returns a CLI-faithful result", async () => {
    const seen: Array<Record<string, string>> = [];
    const harness = createDispatchHarness({
      greet: (flags) => {
        seen.push(flags);
        return `hello ${flags.name}`;
      },
    });
    const client = harness.createClient();

    const result = await client.exec("greet", { name: "world" });

    expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: "hello world\n" });
    // The synthesized argv reports the command the caller asked for.
    expect(result.argv).toEqual(["vault=test", "greet", "name=world"]);
    // The handler saw its exact flags - no nonce pollution.
    expect(seen).toEqual([{ name: "world" }]);
    expect(dispatchRequests(harness.requests)).toHaveLength(1);
    expect(installRequests(harness.requests)).toHaveLength(1);

    await client.exec("greet", { name: "again" });
    // The shim install is memoized across calls.
    expect(installRequests(harness.requests)).toHaveLength(1);
  });

  it("preserves CLI error semantics: error replies on stdout with exit code 0", async () => {
    const harness = createDispatchHarness({
      "throws-error": () => {
        throw new Error("kaboom");
      },
      "throws-string": () => {
        throw "nope";
      },
      quiet: () => undefined,
      zero: () => 0,
    });
    const client = harness.createClient();

    await expect(client.exec("throws-string")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Error: nope\n",
    });
    await expect(client.exec("throws-error")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Error: kaboom\n",
    });
    await expect(client.exec("quiet")).resolves.toMatchObject({ exitCode: 0, stdout: "" });
    // A falsy resolution writes nothing on the direct path (`d && b(d)` in
    // Obsidian's main process) - the recovered path matches.
    await expect(client.exec("zero")).resolves.toMatchObject({ exitCode: 0, stdout: "" });
    await expect(client.exec("no-such-command")).resolves.toMatchObject({
      exitCode: 0,
      stdout:
        'Error: Command "no-such-command" not found. It may require a plugin to be enabled.\n',
    });
  });

  it("recovers a reply lost after the command executed - exactly once", async () => {
    let runs = 0;
    const harness = createDispatchHarness({
      "run-once": () => {
        runs += 1;
        return "ran";
      },
    });
    harness.setBehavior((request) =>
      request.argv[1] === DISPATCH_COMMAND && dispatchRequests(harness.requests).length === 1
        ? "drop-reply"
        : undefined,
    );
    const client = harness.createClient();

    const result = await client.exec("run-once");

    expect(result.stdout).toBe("ran\n");
    expect(runs).toBe(1);
    // One dispatch attempt (reply dropped) + recovery polls, no resend.
    expect(dispatchRequests(harness.requests)).toHaveLength(1);
  });

  it("a delayed dispatch firing after recovery cannot double-execute", async () => {
    let runs = 0;
    const harness = createDispatchHarness({
      "run-once": () => {
        runs += 1;
        return "ran";
      },
    });
    // First dispatch request gets stuck in the bridge; the resend goes through.
    harness.setBehavior((request) =>
      request.argv[1] === DISPATCH_COMMAND && dispatchRequests(harness.requests).length === 1
        ? "delay-request"
        : undefined,
    );
    const client = harness.createClient();

    const result = await client.exec("run-once");

    expect(result.stdout).toBe("ran\n");
    expect(runs).toBe(1);
    expect(dispatchRequests(harness.requests)).toHaveLength(2);

    // The stuck original fires afterwards: the nonce dedup joins the finished
    // run instead of re-executing, and replies with the stored envelope.
    const [lateReply] = await harness.flushDelayed();
    expect(runs).toBe(1);
    expect(parseDispatchEnvelope(lateReply ?? "")).toMatchObject({ reply: "ran", state: "done" });
  });

  it("throws context-reset when the registry vanishes while an attempt's fate is unknown", async () => {
    const harness = createDispatchHarness({
      mutate: () => "mutated",
    });
    harness.setBehavior((request) => {
      if (request.argv[1] !== DISPATCH_COMMAND) {
        return undefined;
      }
      // The attempt executes but its reply is lost; then the renderer
      // "reloads": the shim global and the wrapped handleCli disappear.
      queueMicrotask(() => {
        const globals = globalThis as MutableGlobal;
        delete globals[SHIM_GLOBAL];
      });
      return "drop-reply";
    });
    const client = harness.createClient();

    const error = await client.exec("mutate", {}, { timeoutMs: 2_000 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ObsidianCommandDispatchError);
    expect((error as ObsidianCommandDispatchError).reason).toBe("context-reset");

    // The next exec() reinstalls the shim and works again.
    harness.setBehavior(() => undefined);
    await expect(client.exec("mutate")).resolves.toMatchObject({ stdout: "mutated\n" });
    expect(installRequests(harness.requests)).toHaveLength(2);
  });

  it("never resends after a frame-disposal reply - the dispatch's fate is unknown", async () => {
    let runs = 0;
    const harness = createDispatchHarness({
      "run-once": () => {
        runs += 1;
        return "ran";
      },
    });
    harness.setBehavior((request) => {
      if (request.argv[1] !== DISPATCH_COMMAND) {
        return undefined;
      }
      // The context reset that produced the frame-disposal reply also wipes
      // the shim registry.
      delete (globalThis as MutableGlobal)[SHIM_GLOBAL];
      return "frame-disposed";
    });
    const client = harness.createClient();

    const error = await client.exec("run-once", {}, { timeoutMs: 2_000 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ObsidianCommandDispatchError);
    expect((error as ObsidianCommandDispatchError).reason).toBe("context-reset");
    // The command was never re-dispatched into the fresh context.
    expect(dispatchRequests(harness.requests)).toHaveLength(1);
    expect(runs).toBe(0);
  });

  it("reinstalls and resends after the not-found reply that proves the command never ran", async () => {
    let runs = 0;
    const harness = createDispatchHarness({
      "run-once": () => {
        runs += 1;
        return "ran";
      },
    });
    const client = harness.createClient();

    // Warm the shim, then simulate a renderer reload between calls: the shim
    // global and the handleCli wrapper are gone, so the next dispatch hits
    // Obsidian's real parser and gets the deterministic not-found reply.
    await client.exec("run-once");
    const globals = globalThis as MutableGlobal;
    delete globals[SHIM_GLOBAL];
    globals.handleCli = harness.realHandleCli;

    await expect(client.exec("run-once")).resolves.toMatchObject({ stdout: "ran\n" });

    expect(runs).toBe(2);
    // First call: one dispatch. Second call: not-found probe + resend.
    expect(dispatchRequests(harness.requests)).toHaveLength(3);
    expect(installRequests(harness.requests)).toHaveLength(2);
  });

  it("reports still-pending when a lost reply leaves the handler running", async () => {
    const harness = createDispatchHarness({
      forever: () => new Promise(() => {}),
    });
    harness.setBehavior((request) =>
      request.argv[1] === DISPATCH_COMMAND ? "drop-reply" : undefined,
    );
    const client = harness.createClient();

    const error = await client.exec("forever", {}, { timeoutMs: 500 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ObsidianCommandDispatchError);
    expect((error as ObsidianCommandDispatchError).reason).toBe("still-pending");
  });

  it("reports still-pending after a clean pending acknowledgement", async () => {
    const harness = createDispatchHarness({
      forever: () => new Promise(() => {}),
    });
    const client = harness.createClient();

    const error = await client.exec("forever", {}, { timeoutMs: 350 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ObsidianCommandDispatchError);
    expect((error as ObsidianCommandDispatchError).reason).toBe("still-pending");
    expect(harness.dispatchReplies.map((reply) => parseDispatchEnvelope(reply))).toContainEqual({
      installId: expect.any(String),
      state: "pending",
    });
    expect(dispatchRequests(harness.requests)).toHaveLength(1);
  });

  it("reports ambiguous-delivery when nothing is ever acknowledged", async () => {
    const harness = createDispatchHarness({});
    harness.setBehavior((request) => {
      if (request.argv[1] === DISPATCH_COMMAND) {
        return "delay-request";
      }
      // Polls fail too, but only after the shim install succeeded.
      if (request.argv[1] === "eval" && installRequests(harness.requests).length >= 1) {
        return (request.argv[2] ?? "").includes("window.handleCli") ? undefined : "timeout";
      }
      return undefined;
    });
    const client = harness.createClient();

    const error = await client.exec("anything", {}, { timeoutMs: 500 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ObsidianCommandDispatchError);
    expect((error as ObsidianCommandDispatchError).reason).toBe("ambiguous-delivery");
    expect((error as ObsidianCommandDispatchError).causeError).toBeInstanceOf(
      ObsidianCommandTimeoutError,
    );
  });

  it("returns the socket failure result when the caller allows nonzero exits", async () => {
    const harness = createDispatchHarness({});
    harness.setBehavior((request) =>
      request.argv[1] === DISPATCH_COMMAND ? "fail-exit" : undefined,
    );
    const client = harness.createClient();

    const result = await client.exec("anything", { flag: "x" }, { allowNonZeroExit: true });
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    // The outcome is reported against the caller's command, not the internal
    // dispatch verb.
    expect(result.argv).toEqual(["vault=test", "anything", "flag=x"]);
    await expect(client.exec("anything")).rejects.toBeInstanceOf(ObsidianCommandError);
  });

  it("keeps context-destroying palette ids on the direct path", async () => {
    const harness = createDispatchHarness({
      command: (flags) => `ran ${flags.id}`,
    });
    const client = harness.createClient();

    await expect(client.exec("command", { id: "app:reload" })).resolves.toMatchObject({
      stdout: "ran app:reload\n",
    });
    expect(dispatchRequests(harness.requests)).toHaveLength(0);

    await expect(client.exec("command", { id: "quickadd:run" })).resolves.toMatchObject({
      stdout: "ran quickadd:run\n",
    });
    expect(dispatchRequests(harness.requests)).toHaveLength(1);
  });

  it("propagates hard install failures immediately instead of retrying out the deadline", async () => {
    const harness = createDispatchHarness({ greet: () => "hello" });
    harness.setBehavior((request) => (request.argv[1] === "eval" ? "fail-exit" : undefined));
    const client = harness.createClient();

    const start = Date.now();
    await expect(client.exec("greet", {}, { timeoutMs: 10_000 })).rejects.toBeInstanceOf(
      ObsidianCommandError,
    );
    // A cold-app connect failure surfaces like the direct path does - fast -
    // so waitFor probes keep their own cadence.
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("bounds waiting on a shared shim install by each caller's own deadline", async () => {
    const harness = createDispatchHarness({ greet: () => "hello" });
    harness.setBehavior((request) => (request.argv[1] === "eval" ? "hang" : undefined));
    const client = harness.createClient();

    // The first caller creates the (never-resolving) shared install.
    const first = client.exec("greet", {}, { timeoutMs: 3_000 });
    first.catch(() => {});

    const start = Date.now();
    const error = await client.exec("greet", {}, { timeoutMs: 300 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ObsidianCommandDispatchError);
    expect((error as ObsidianCommandDispatchError).reason).toBe("undelivered");
    // The short-deadline caller did not inherit the shared install's budget.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("caps proof-gated resends with a precise undelivered failure", async () => {
    let runs = 0;
    const harness = createDispatchHarness({
      "run-once": () => {
        runs += 1;
        return "ran";
      },
    });
    // Before every dispatch attempt the renderer "reloads": the shim global
    // vanishes and handleCli reverts, so each attempt gets the deterministic
    // not-found reply, reinstalls, and resends - forever, without the cap.
    harness.setBehavior((request) => {
      if (request.argv[1] === DISPATCH_COMMAND) {
        const globals = globalThis as MutableGlobal;
        delete globals[SHIM_GLOBAL];
        globals.handleCli = harness.realHandleCli;
      }
      return undefined;
    });
    const client = harness.createClient();

    const error = await client.exec("run-once", {}, { timeoutMs: 30_000 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ObsidianCommandDispatchError);
    expect((error as ObsidianCommandDispatchError).reason).toBe("undelivered");
    expect(runs).toBe(0);
    expect(dispatchRequests(harness.requests).length).toBeLessThanOrEqual(8);
  });

  it("keeps context-destroying verbs and recoverable:false on the direct path", async () => {
    const harness = createDispatchHarness({
      greet: () => "hello",
      reload: () => "Reloading...",
    });
    const client = harness.createClient();

    await expect(client.exec("reload")).resolves.toMatchObject({ stdout: "Reloading...\n" });
    await expect(client.exec("greet", {}, { recoverable: false })).resolves.toMatchObject({
      stdout: "hello\n",
    });

    expect(dispatchRequests(harness.requests)).toHaveLength(0);
    expect(installRequests(harness.requests)).toHaveLength(0);
  });

  it("defaults custom transports to the direct path", async () => {
    const harness = createDispatchHarness({ greet: () => "hello" });
    const client = createObsidianClient({
      transport: async (request) => {
        harness.requests.push(request.argv);
        return createExecResult(request.bin, request.argv, "hello\n");
      },
      vault: "test",
    });

    await expect(client.exec("greet")).resolves.toMatchObject({ stdout: "hello\n" });
    expect(harness.requests).toEqual([["vault=test", "greet"]]);
  });

  it("falls back to the direct path on apps without window.handleCli", async () => {
    const harness = createDispatchHarness({ greet: () => "hello" });
    delete (globalThis as MutableGlobal).handleCli;
    const client = harness.createClient();

    await expect(client.exec("greet")).resolves.toMatchObject({ stdout: "hello\n" });
    await expect(client.exec("greet")).resolves.toMatchObject({ stdout: "hello\n" });

    expect(dispatchRequests(harness.requests)).toHaveLength(0);
    expect(installRequests(harness.requests)).toHaveLength(1);
  });

  it("re-probes an unsupported app after the cache window", async () => {
    const harness = createDispatchHarness({ greet: () => "hello" });
    delete (globalThis as MutableGlobal).handleCli;
    const state = createDispatchState();
    const context = {
      bin: "obsidian",
      state,
      transport: harness.transport,
      vault: "test",
    };

    await expect(runRecoverableExec(context, "greet", {}, {})).resolves.toMatchObject({
      stdout: "hello\n",
    });
    expect(state.unsupportedAt).not.toBeNull();

    state.unsupportedAt = Date.now() - 60_001;
    await expect(runRecoverableExec(context, "greet", {}, {})).resolves.toMatchObject({
      stdout: "hello\n",
    });

    expect(installRequests(harness.requests)).toHaveLength(2);
  });

  it("carries dev.evalJson through the dispatch protocol end to end", async () => {
    const harness = createDispatchHarness({
      eval: (flags) => (0, eval)(flags.code ?? "") as string,
    });
    const client = harness.createClient();

    await expect(client.dev.evalJson<{ items: number[] }>("({ items: [1, 2] })")).resolves.toEqual({
      items: [1, 2],
    });
    expect(dispatchRequests(harness.requests)).toHaveLength(1);
  });
});

describe("dispatch shim", () => {
  it("returns done in one roundtrip when the handler settles inside grace", async () => {
    let runs = 0;
    createDispatchHarness({
      quick: () => {
        runs += 1;
        return "ok";
      },
    });
    (0, eval)(buildDispatchShimCode("gen-1"));
    const handleCli = (globalThis as MutableGlobal).handleCli as (
      argv: string[],
    ) => Promise<string>;

    const reply = await handleCli([
      DISPATCH_COMMAND,
      `payload=${JSON.stringify({ argv: ["quick"], graceMs: 20, installId: "gen-1", nonce: "n1" })}`,
    ]);

    expect(JSON.parse(reply)).toEqual({
      installId: "gen-1",
      reply: "ok",
      state: "done",
    });
    expect(runs).toBe(1);
  });

  it("returns pending after entry grace without dispatching a duplicate", async () => {
    let runs = 0;
    createDispatchHarness({
      forever: () => {
        runs += 1;
        return new Promise(() => {});
      },
    });
    (0, eval)(buildDispatchShimCode("gen-1"));
    const handleCli = (globalThis as MutableGlobal).handleCli as (
      argv: string[],
    ) => Promise<string>;
    const request = [
      DISPATCH_COMMAND,
      `payload=${JSON.stringify({ argv: ["forever"], graceMs: 20, installId: "gen-1", nonce: "n1" })}`,
    ];

    await expect(handleCli(request)).resolves.toBe(
      JSON.stringify({ installId: "gen-1", state: "pending" }),
    );
    await expect(handleCli(request)).resolves.toBe(
      JSON.stringify({ installId: "gen-1", state: "pending" }),
    );
    expect(runs).toBe(1);
  });

  it("joins duplicate arrivals before a fast handler settles", async () => {
    let runs = 0;
    createDispatchHarness({
      quick: async () => {
        runs += 1;
        await sleep(20);
        return "ok";
      },
    });
    (0, eval)(buildDispatchShimCode("gen-1"));
    const handleCli = (globalThis as MutableGlobal).handleCli as (
      argv: string[],
    ) => Promise<string>;
    const request = [
      DISPATCH_COMMAND,
      `payload=${JSON.stringify({ argv: ["quick"], graceMs: 50, installId: "gen-1", nonce: "n1" })}`,
    ];

    const replies = await Promise.all([handleCli(request), handleCli(request)]);

    expect(replies.map((reply) => JSON.parse(reply))).toEqual([
      { installId: "gen-1", reply: "ok", state: "done" },
      { installId: "gen-1", reply: "ok", state: "done" },
    ]);
    expect(runs).toBe(1);
  });

  it("refuses payloads pinned to another registry generation without dispatching", async () => {
    let runs = 0;
    createDispatchHarness({
      "run-once": () => {
        runs += 1;
        return "ran";
      },
    });
    (0, eval)(buildDispatchShimCode("gen-1"));
    const handleCli = (globalThis as MutableGlobal).handleCli as (
      argv: string[],
    ) => Promise<string>;

    const stale = await handleCli([
      DISPATCH_COMMAND,
      `payload=${JSON.stringify({ argv: ["run-once"], installId: "gen-0", nonce: "n1" })}`,
    ]);

    expect(JSON.parse(stale)).toEqual({ installId: "gen-1", state: "stale" });
    expect(runs).toBe(0);
  });

  it("is idempotent: a second install returns the existing generation", () => {
    createDispatchHarness({});
    const first = (0, eval)(buildDispatchShimCode("gen-1")) as { installId: string };
    const second = (0, eval)(buildDispatchShimCode("gen-2")) as { installId: string };

    expect(first.installId).toBe("gen-1");
    expect(second.installId).toBe("gen-1");
  });

  it("evicts only settled entries whose TTL passed, never in-flight or live ones", async () => {
    createDispatchHarness({
      hang: () => new Promise(() => {}),
      quick: () => "ok",
    });
    (0, eval)(buildDispatchShimCode("gen-1"));
    const handleCli = (globalThis as MutableGlobal).handleCli as (
      argv: string[],
    ) => Promise<string>;
    const dispatch = (nonce: string, command: string, ttlMs: number) =>
      handleCli([
        DISPATCH_COMMAND,
        `payload=${JSON.stringify({ argv: [command], installId: "gen-1", nonce, ttlMs })}`,
      ]);

    void dispatch("pending-expired", "hang", 1);
    await dispatch("done-expired", "quick", 1);
    await dispatch("done-live", "quick", 60_000);
    await sleep(10);
    // A new insert triggers the eviction scan.
    await dispatch("fresh", "quick", 60_000);

    const ops = ((globalThis as MutableGlobal)[SHIM_GLOBAL] as { ops: Map<string, unknown> }).ops;
    // Only the settled entry whose TTL passed is reclaimed; a pending entry is
    // never evicted regardless of age, and live entries survive.
    expect(ops.has("done-expired")).toBe(false);
    expect(ops.has("pending-expired")).toBe(true);
    expect(ops.has("done-live")).toBe(true);
    expect(ops.has("fresh")).toBe(true);
  });
});
