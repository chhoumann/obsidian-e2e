import { randomUUID } from "node:crypto";

import { buildArgTokens, buildCommandArgv } from "./args";
import {
  ObsidianCommandDispatchError,
  ObsidianCommandError,
  ObsidianCommandTimeoutError,
  isRecord,
} from "./errors";
import { runEvalJson } from "../dev/eval-json";
import type { CommandTransport, ExecOptions, ExecResult, ObsidianArg } from "./types";
import { sleep } from "./wait";

/**
 * Recoverable command dispatch for `exec()` (#25).
 *
 * Every Obsidian CLI command travels client process -> unix socket -> app main
 * process -> `webContents.executeJavaScript("window.handleCli(argv)")` in the
 * renderer -> the resolved string crosses back over the same bridge -> socket
 * write. The bridge loses and delays messages in both directions under load
 * (observed live: a `plugin:reload` completed in-app in 11ms and its reply
 * never arrived; an eval request was delayed 13.7s while neighbors were
 * instant), and Obsidian's CLI server has no timeout or retry around it - a
 * lost reply hangs the client until our transport kills it.
 *
 * The protocol here keeps the happy path at a single CLI roundtrip while
 * making a lost reply recoverable and a lost request safely resendable:
 *
 * - A one-time shim wraps `window.handleCli` in the renderer. It passes every
 *   normal command through untouched and intercepts one synthetic verb,
 *   `__obsidian-e2e:dispatch payload=<json>`, whose payload carries the real
 *   command argv, a per-call nonce, and the shim generation (`installId`) the
 *   client verified.
 * - The shim records `{state:'pending'}` under the nonce before dispatching,
 *   stores the final reply on settle, and dedups: a second arrival of the same
 *   nonce joins the original run instead of re-dispatching. Payloads pinned to
 *   another generation are refused (`state:'stale'`) without dispatching.
 * - The client sends one dispatch attempt on a short process budget; if the
 *   reply is lost it polls the registry with idempotent reads, and resends the
 *   same nonce only when the registry proves the command never dispatched in
 *   the pinned generation.
 *
 * Together nonce dedup + generation pinning give at-most-once execution
 * unconditionally, and exactly-once whenever the renderer context survives -
 * the only case in which the command could have run at all.
 */
export const DISPATCH_COMMAND = "__obsidian-e2e:dispatch";

const DISPATCH_REGISTRY = "__obsidianE2EDispatch";
/**
 * Ring bound for remembered dispatches. Entries are small strings; the cap
 * only exists so an eternal warm instance cannot grow without bound. Pending
 * entries are never evicted (evicting one would forget an in-flight dedup),
 * and a done entry is only reclaimed after 2000 younger dispatches - far
 * beyond what any client still polling for it could observe.
 */
const DISPATCH_REGISTRY_CAP = 2_000;

/**
 * Process budget for a single dispatch attempt. Commands normally settle in
 * milliseconds; when a reply is lost this bounds the stall before recovery
 * polling starts. A command still running when the budget kills the CLI
 * process is unaffected in-app - polls carry its result afterwards.
 */
const DISPATCH_ATTEMPT_TIMEOUT_MS = 5_000;
/** Budget for internal install/poll commands; mirrors the evalJsonAsync value. */
const DISPATCH_INTERNAL_TIMEOUT_MS = 10_000;
const DISPATCH_POLL_INTERVAL_MS = 100;
/** Mirrors the transport's default command timeout, which bounded the direct form. */
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

const PAYLOAD_PREFIX = "payload=";

export interface DispatchState {
  installId: string | null;
  installPromise: Promise<string | null> | null;
  unsupported: boolean;
}

export function createDispatchState(): DispatchState {
  return {
    installId: null,
    installPromise: null,
    unsupported: false,
  };
}

export interface DispatchContext {
  bin: string;
  state: DispatchState;
  transport: CommandTransport;
  vault: string;
}

interface DispatchDoneEnvelope {
  installId: string;
  reply: string;
  state: "done";
}

interface DispatchStaleEnvelope {
  installId: string;
  state: "stale";
}

type DispatchEnvelope = DispatchDoneEnvelope | DispatchStaleEnvelope;

interface DispatchPollResult {
  installId: string;
  reply: string | null;
  state: "done" | "missing" | "pending";
}

/**
 * Installer for the in-app dispatch shim. Idempotent: a repeated install (e.g.
 * after its own reply was lost) returns the existing generation instead of
 * re-wrapping. `installId: null` reports an app without `window.handleCli`,
 * which the client treats as "recovery unsupported, use the direct path".
 */
export function buildDispatchShimCode(
  installId: string,
  registryCap: number = DISPATCH_REGISTRY_CAP,
): string {
  return [
    "(()=>{",
    `const existing=globalThis.${DISPATCH_REGISTRY};`,
    "if(existing){return {installId:existing.installId};}",
    "const handleCli=window.handleCli;",
    "if(typeof handleCli!=='function'){return {installId:null};}",
    `const installId=${JSON.stringify(installId)};`,
    "const ops=new Map();",
    `const evictDone=()=>{if(ops.size<=${registryCap}){return;}for(const [nonce,entry] of ops){if(entry.state==='done'){ops.delete(nonce);return;}}};`,
    "window.handleCli=(argv)=>{",
    `if(!Array.isArray(argv)||argv.length!==2||argv[0]!==${JSON.stringify(DISPATCH_COMMAND)}||typeof argv[1]!=='string'||!argv[1].startsWith(${JSON.stringify(PAYLOAD_PREFIX)})){return handleCli(argv);}`,
    "let payload;",
    `try{payload=JSON.parse(argv[1].slice(${PAYLOAD_PREFIX.length}));}catch(error){return Promise.resolve(JSON.stringify({installId,state:'done',reply:'Error: obsidian-e2e dispatch payload was not valid JSON'}));}`,
    // Generation pinning: a payload pinned to a previous install (the window
    // reloaded between pinning and arrival) is refused without dispatching, so
    // a delayed duplicate can never execute against a registry that lost its
    // dedup memory.
    "if(payload.installId!==installId){return Promise.resolve(JSON.stringify({installId,state:'stale'}));}",
    "const nonce=String(payload.nonce);",
    "let entry=ops.get(nonce);",
    "if(!entry){",
    "entry={state:'pending',reply:null,settled:null};",
    // Reply formatting mirrors Obsidian's main process exactly (resolve ->
    // value; string throw -> "Error: " + s; other throw -> String(err)), so
    // the recovered output is byte-identical to the direct CLI output.
    "entry.settled=Promise.resolve().then(()=>handleCli(payload.argv)).then((value)=>value==null?'':String(value),(error)=>typeof error==='string'?'Error: '+error:String(error)).then((reply)=>{entry.state='done';entry.reply=reply;return reply;});",
    "ops.set(nonce,entry);",
    "evictDone();",
    "}",
    "return entry.settled.then((reply)=>JSON.stringify({installId,state:'done',reply}));",
    "};",
    `globalThis.${DISPATCH_REGISTRY}={installId,ops};`,
    "return {installId};",
    "})()",
  ].join("");
}

/** Pure read; safe to repeat after any lost or failed reply. */
export function buildDispatchPollCode(nonce: string): string {
  return [
    "(()=>{",
    `const shim=globalThis.${DISPATCH_REGISTRY};`,
    "if(!shim){return null;}",
    `const entry=shim.ops.get(${JSON.stringify(nonce)})??null;`,
    "if(!entry){return {installId:shim.installId,state:'missing',reply:null};}",
    "return {installId:shim.installId,state:entry.state,reply:entry.state==='done'?entry.reply:null};",
    "})()",
  ].join("");
}

export function buildDispatchPayload(
  installId: string,
  nonce: string,
  command: string,
  args: Record<string, ObsidianArg>,
): string {
  return JSON.stringify({
    argv: [command, ...buildArgTokens(args)],
    installId,
    nonce,
  });
}

/**
 * Whether a served non-envelope reply is Obsidian's own "command not found"
 * answer for the dispatch verb - the one reply that proves the shim is gone
 * AND the inner command was never parsed, making a resend safe. Any other
 * non-envelope reply (e.g. a frame-disposal error delivered by the main
 * process) leaves the dispatch's fate unknown.
 */
export function isDispatchVerbNotFound(stdout: string): boolean {
  return stdout.includes(`"${DISPATCH_COMMAND}" not found`);
}

/** Parse a dispatch attempt's stdout; `null` means it is not a shim envelope. */
export function parseDispatchEnvelope(stdout: string): DispatchEnvelope | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.installId !== "string") {
    return null;
  }

  if (parsed.state === "stale") {
    return { installId: parsed.installId, state: "stale" };
  }

  if (parsed.state === "done" && typeof parsed.reply === "string") {
    return { installId: parsed.installId, reply: parsed.reply, state: "done" };
  }

  return null;
}

/**
 * Reconstruct the ExecResult the direct CLI path would have produced from a
 * stored reply. The CLI client exits 0 whenever the server serves a reply -
 * including "Error: ..." replies - and appends a newline to non-empty output;
 * an empty reply writes nothing (verified live against Obsidian 1.13.4).
 */
function synthesizeExecResult(bin: string, argv: string[], reply: string): ExecResult {
  return {
    argv,
    command: bin,
    exitCode: 0,
    stderr: "",
    stdout: reply === "" ? "" : reply.endsWith("\n") ? reply : `${reply}\n`,
  };
}

export async function runRecoverableExec(
  ctx: DispatchContext,
  command: string,
  args: Record<string, ObsidianArg>,
  execOptions: ExecOptions,
): Promise<ExecResult> {
  const timeoutMs = execOptions.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const directArgv = buildCommandArgv(ctx.vault, command, args);
  const remaining = () => deadline - Date.now();
  const budget = (ms: number) => Math.max(1, Math.min(ms, remaining()));

  const internalOptions = (budgetMs: number): ExecOptions => ({
    ...execOptions,
    allowNonZeroExit: false,
    timeoutMs: budget(budgetMs),
  });

  // Direct evals used by install and polls. They bypass exec() on purpose:
  // routing them through the recoverable path would recurse.
  const directDev = {
    evalRaw: async (code: string, evalOptions: ExecOptions = {}) => {
      const result = await ctx.transport({
        ...evalOptions,
        argv: buildCommandArgv(ctx.vault, "eval", { code }),
        bin: ctx.bin,
      });
      return result.stdout.trimEnd();
    },
  };

  const nonce = randomUUID();
  const fail = (
    reason: "ambiguous-delivery" | "context-reset" | "still-pending" | "undelivered",
    message: string,
    causeError?: unknown,
  ) =>
    new ObsidianCommandDispatchError(
      `${message} (command "${command}", nonce ${nonce})`,
      reason,
      nonce,
      directArgv,
      causeError,
    );

  let lastError: unknown;

  // Install phase. The memoized promise is shared across concurrent exec()
  // calls; a failed install clears it so the next caller retries. Detection of
  // an app without window.handleCli is cached and downgrades every future
  // exec() to the direct path.
  const ensureShim = async (): Promise<string | null> => {
    const { state } = ctx;
    while (true) {
      if (state.unsupported) {
        return null;
      }

      if (!state.installPromise) {
        const candidate = randomUUID();
        state.installPromise = runEvalJson<{ installId: string | null } | null>(
          directDev,
          buildDispatchShimCode(candidate),
          internalOptions(DISPATCH_INTERNAL_TIMEOUT_MS),
        ).then((value) =>
          // Anything but the shim's own {installId: string} answer means the
          // app cannot host the protocol; degrade to the direct path.
          typeof value?.installId === "string" ? value.installId : null,
        );
      }

      try {
        const installId = await state.installPromise;
        if (installId === null) {
          state.unsupported = true;
          return null;
        }
        state.installId = installId;
        return installId;
      } catch (error) {
        state.installPromise = null;
        lastError = error;
        if (remaining() <= DISPATCH_POLL_INTERVAL_MS) {
          throw fail(
            "undelivered",
            `The dispatch shim could not be installed within ${timeoutMs}ms; the command was never dispatched and did not run`,
            lastError,
          );
        }
        await sleep(Math.min(DISPATCH_POLL_INTERVAL_MS, remaining()));
      }
    }
  };

  const invalidateShim = (installId: string) => {
    if (ctx.state.installId === installId) {
      ctx.state.installId = null;
      ctx.state.installPromise = null;
    }
  };

  const initialInstallId = await ensureShim();

  if (initialInstallId === null) {
    // App without window.handleCli: recovery is unsupported, preserve the
    // exact legacy single-shot behavior.
    return ctx.transport({
      ...execOptions,
      argv: directArgv,
      bin: ctx.bin,
      timeoutMs: budget(timeoutMs),
    });
  }

  let installId = initialInstallId;
  let payload = buildDispatchPayload(installId, nonce, command, args);
  let confirmedRunning = false;
  let shouldSend = true;
  // Attempts whose fate is unknown (timed out). While any exist, entering a
  // new shim generation is not provably safe: the attempt may have executed
  // just before the context reset that created the generation.
  let unknownFateAttempts = 0;

  const contextReset = (installIdAtFailure: string, causeError?: unknown) => {
    invalidateShim(installIdAtFailure);
    return fail(
      "context-reset",
      "The Obsidian renderer context was reset (e.g. an app or vault reload) while the command was in flight; whether it executed before the reset is unknowable",
      causeError,
    );
  };

  while (remaining() > 0) {
    if (shouldSend) {
      shouldSend = false;
      try {
        const attempt = await ctx.transport({
          ...execOptions,
          allowNonZeroExit: false,
          argv: buildCommandArgv(ctx.vault, DISPATCH_COMMAND, { payload }),
          bin: ctx.bin,
          timeoutMs: budget(DISPATCH_ATTEMPT_TIMEOUT_MS),
        });
        const envelope = parseDispatchEnvelope(attempt.stdout);

        if (envelope === null && !isDispatchVerbNotFound(attempt.stdout)) {
          // A served reply that is neither a shim envelope nor Obsidian's
          // not-found answer for the dispatch verb. The known producer is a
          // renderer teardown mid-request (Obsidian's main process converts
          // the executeJavaScript rejection into a delivered string like
          // "Error: Render frame was disposed..."), in which case the
          // dispatch may have executed before the context died - resending
          // would risk a double run. Treat the fate as unknown and let the
          // polls classify the context.
          unknownFateAttempts += 1;
          lastError = new Error(`Unrecognized dispatch reply: ${attempt.stdout.slice(0, 500)}`);
        } else if (envelope === null || envelope.state === "stale") {
          // Obsidian's parser answered "command not found" (the shim is gone
          // and the inner command was never parsed) or the live shim refused
          // a payload pinned to a previous generation. Either way THIS
          // attempt provably did not run. Re-pinning and resending is safe
          // only while no earlier attempt has unknown fate.
          if (unknownFateAttempts > 0) {
            throw contextReset(installId);
          }
          invalidateShim(installId);
          const reinstalledId = await ensureShim();
          if (reinstalledId === null) {
            throw fail(
              "undelivered",
              "The dispatch shim disappeared and could not be reinstalled; the command was never dispatched and did not run",
              lastError,
            );
          }
          installId = reinstalledId;
          payload = buildDispatchPayload(installId, nonce, command, args);
          shouldSend = true;
          continue;
        }

        if (envelope !== null && envelope.state === "done") {
          return synthesizeExecResult(ctx.bin, directArgv, envelope.reply);
        }
      } catch (error) {
        if (error instanceof ObsidianCommandDispatchError) {
          throw error;
        }
        if (error instanceof ObsidianCommandTimeoutError) {
          unknownFateAttempts += 1;
          lastError = error;
        } else if (error instanceof ObsidianCommandError && execOptions.allowNonZeroExit) {
          // A nonzero exit means the socket failed before a reply was served;
          // callers that opted into nonzero exits get the result, as on the
          // direct path.
          return error.result;
        } else {
          throw error;
        }
      }
    }

    try {
      const poll = await runEvalJson<DispatchPollResult | null>(
        directDev,
        buildDispatchPollCode(nonce),
        internalOptions(DISPATCH_INTERNAL_TIMEOUT_MS),
      );

      if (poll === null || poll.installId !== installId) {
        // Polls only run after a timed-out attempt, whose fate is unknown; a
        // wiped or regenerated registry makes that fate unknowable.
        throw contextReset(installId);
      }

      if (poll.state === "done" && poll.reply !== null) {
        return synthesizeExecResult(ctx.bin, directArgv, poll.reply);
      }

      if (poll.state === "pending") {
        confirmedRunning = true;
      } else if (poll.state === "missing" && !confirmedRunning) {
        // Same generation and no registry entry: the attempt provably never
        // dispatched (a delayed duplicate that fires later is dedup'd by the
        // nonce). Resend immediately.
        shouldSend = true;
        continue;
      }
    } catch (error) {
      if (error instanceof ObsidianCommandDispatchError) {
        throw error;
      }
      lastError = error;
    }

    await sleep(Math.max(0, Math.min(DISPATCH_POLL_INTERVAL_MS, remaining())));
  }

  if (confirmedRunning) {
    throw fail(
      "still-pending",
      `The command is still running in Obsidian after ${timeoutMs}ms; its handler has not settled. It may still complete in-app`,
      lastError,
    );
  }

  throw fail(
    "ambiguous-delivery",
    `No dispatch attempt was acknowledged within ${timeoutMs}ms and no in-app record of the command appeared; it may or may not have started. The nonce was never re-dispatched, so the command cannot have run twice`,
    lastError,
  );
}
