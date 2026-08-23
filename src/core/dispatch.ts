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
 * Grace added to a dispatch's remaining deadline to form its registry entry's
 * TTL. Eviction is TTL-based, not slot-based, so the at-most-once argument
 * holds at any traffic volume: an entry provably outlives every moment its
 * caller could still resend (resends stop at the deadline; the entry survives
 * to deadline + margin), and memory stays bounded by traffic rate x TTL
 * because expired entries are reclaimed as new dispatches arrive.
 */
const DISPATCH_ENTRY_TTL_MARGIN_MS = 60_000;
/** Oldest entries scanned for expiry per insert; keeps eviction amortized O(1). */
const DISPATCH_EVICTION_SCAN_LIMIT = 50;
const DISPATCH_GRACE_MS = 1_500;
const DISPATCH_MAX_GRACE_MS = 5_000;

/**
 * Process budget for a single dispatch attempt. The shim answers inside
 * DISPATCH_GRACE_MS or with `{state:'pending'}`, so this only has to cover
 * grace plus bridge slack. A lost reply or a pending ack both fall into
 * polling. A command still running when the budget kills the CLI process is
 * unaffected in-app.
 */
const DISPATCH_ATTEMPT_TIMEOUT_MS = 2_500;
/** Budget for internal install/poll commands; mirrors the evalJsonAsync value. */
const DISPATCH_INTERNAL_TIMEOUT_MS = 10_000;
const DISPATCH_POLL_INTERVAL_MS = 100;
const DISPATCH_POLL_MAX_INTERVAL_MS = 1_000;
const DISPATCH_UNSUPPORTED_REPROBE_MS = 60_000;
/** Mirrors the transport's default command timeout, which bounded the direct form. */
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
/**
 * Hard bound on how many times one exec() call may send its dispatch. Resends
 * are only ever authorized by proof the nonce never ran, so a pathological
 * environment (e.g. an app stuck in a reload loop answering "not found"
 * forever) fails with a precise `undelivered` instead of hammering the CLI
 * socket until the deadline.
 */
const MAX_DISPATCH_SENDS = 8;

const PAYLOAD_PREFIX = "payload=";

export interface DispatchState {
  installId: string | null;
  installPromise: Promise<string | null> | null;
  unsupportedAt: number | null;
}

export function createDispatchState(): DispatchState {
  return {
    installId: null,
    installPromise: null,
    unsupportedAt: null,
  };
}

export function isUnsupportedCached(state: DispatchState, now: number = Date.now()): boolean {
  return (
    state.unsupportedAt !== null && now - state.unsupportedAt < DISPATCH_UNSUPPORTED_REPROBE_MS
  );
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

interface DispatchPendingEnvelope {
  installId: string;
  state: "pending";
}

type DispatchEnvelope = DispatchDoneEnvelope | DispatchPendingEnvelope | DispatchStaleEnvelope;

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
export function buildDispatchShimCode(installId: string): string {
  return [
    "(()=>{",
    `const existing=globalThis.${DISPATCH_REGISTRY};`,
    "if(existing){return {installId:existing.installId};}",
    "const handleCli=window.handleCli;",
    "if(typeof handleCli!=='function'){return {installId:null};}",
    `const installId=${JSON.stringify(installId)};`,
    "const ops=new Map();",
    // TTL-based eviction: an entry is reclaimable only after the deadline its
    // own payload declared (plus margin) has passed, i.e. only once no caller
    // can still resend its nonce. Pending entries are never evicted.
    `const evictExpired=()=>{const now=Date.now();let scanned=0;for(const [nonce,entry] of ops){if(++scanned>${DISPATCH_EVICTION_SCAN_LIMIT}){return;}if(entry.state==='done'&&entry.expiresAt<now){ops.delete(nonce);}}};`,
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
    "const ttlMs=typeof payload.ttlMs==='number'?payload.ttlMs:120000;",
    `const graceMs=Math.max(0,Math.min(${DISPATCH_MAX_GRACE_MS},typeof payload.graceMs==='number'?payload.graceMs:${DISPATCH_GRACE_MS}));`,
    "const now=Date.now();",
    "entry={state:'pending',reply:null,settled:null,expiresAt:now+ttlMs,graceEndsAtMs:now+graceMs};",
    // Reply formatting mirrors Obsidian's main process exactly (a falsy
    // resolution writes nothing - `d && b(d)`; string throw -> "Error: " + s;
    // other throw -> String(err)), so the recovered output is byte-identical
    // to the direct CLI output.
    "entry.settled=Promise.resolve().then(()=>handleCli(payload.argv)).then((value)=>value?String(value):'',(error)=>typeof error==='string'?'Error: '+error:String(error)).then((reply)=>{entry.state='done';entry.reply=reply;return reply;});",
    "ops.set(nonce,entry);",
    "evictExpired();",
    "}",
    "if(entry.state==='done'){return Promise.resolve(JSON.stringify({installId,state:'done',reply:entry.reply}));}",
    "if(Date.now()>=entry.graceEndsAtMs){return Promise.resolve(JSON.stringify({installId,state:'pending'}));}",
    "return new Promise((resolve)=>{const answer=()=>resolve(JSON.stringify(entry.state==='done'?{installId,state:'done',reply:entry.reply}:{installId,state:'pending'}));const timer=setTimeout(answer,Math.max(0,entry.graceEndsAtMs-Date.now()));entry.settled.then(()=>{clearTimeout(timer);answer();});});",
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
  ttlMs: number,
  graceMs: number,
): string {
  return JSON.stringify({
    argv: [command, ...buildArgTokens(args)],
    installId,
    nonce,
    ttlMs,
    graceMs,
  });
}

export function dispatchPollDelayMs(completedPolls: number): number {
  if (completedPolls <= 0) {
    return 0;
  }

  return Math.min(
    DISPATCH_POLL_MAX_INTERVAL_MS,
    DISPATCH_POLL_INTERVAL_MS * 2 ** (completedPolls - 1),
  );
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

  if (parsed.state === "pending") {
    return { installId: parsed.installId, state: "pending" };
  }

  if (parsed.state === "done" && typeof parsed.reply === "string") {
    return { installId: parsed.installId, reply: parsed.reply, state: "done" };
  }

  return null;
}

const INSTALL_DEADLINE = Symbol("install-deadline");

async function raceAgainstDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<T | typeof INSTALL_DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof INSTALL_DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(INSTALL_DEADLINE), Math.max(0, deadlineMs));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reconstruct the ExecResult the direct CLI path would have produced from a
 * stored reply. The CLI client exits 0 whenever the server serves a reply -
 * including "Error: ..." replies - and appends a newline to non-empty output
 * when the reply lacks one; an empty reply writes nothing (verified live
 * against Obsidian 1.13.4 and its decompiled main process).
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

  const ensureShim = async (): Promise<string | null> => {
    const { state } = ctx;
    while (true) {
      if (isUnsupportedCached(state)) {
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

      // The install promise is shared across callers, so a caller with a
      // short deadline must not inherit another caller's install budget: race
      // it against this call's own remaining time. Timing out the race leaves
      // the shared install untouched for other callers and is provably safe
      // for this one - nothing was dispatched for its nonce.
      let raced: string | typeof INSTALL_DEADLINE | null;
      try {
        raced = await raceAgainstDeadline(state.installPromise, remaining());
      } catch (error) {
        state.installPromise = null;
        // Only a lost install reply is worth retrying. Hard failures (connect
        // refused on a cold app, nonzero exits, garbage replies) are the same
        // persistent conditions the direct path surfaces immediately, and
        // callers like waitFor probes rely on that fast failure.
        if (!(error instanceof ObsidianCommandTimeoutError)) {
          throw error;
        }
        lastError = error;
        if (remaining() <= DISPATCH_POLL_INTERVAL_MS) {
          throw fail(
            "undelivered",
            `The dispatch shim could not be installed within ${timeoutMs}ms; the command was never dispatched and did not run`,
            lastError,
          );
        }
        await sleep(Math.min(DISPATCH_POLL_INTERVAL_MS, remaining()));
        continue;
      }

      if (raced === INSTALL_DEADLINE) {
        throw fail(
          "undelivered",
          `The dispatch shim install did not complete within this call's ${timeoutMs}ms deadline; the command was never dispatched and did not run`,
          lastError,
        );
      }

      if (raced === null) {
        state.installPromise = null;
        state.unsupportedAt = Date.now();
        return null;
      }

      state.installId = raced;
      state.unsupportedAt = null;
      return raced;
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

  // The entry TTL outlives every moment this call could still resend (resends
  // stop at the deadline; the entry survives to deadline + margin), which is
  // what makes "missing in the pinned generation" proof of non-execution.
  const entryTtl = () => remaining() + DISPATCH_ENTRY_TTL_MARGIN_MS;
  const entryGrace = () =>
    Math.max(0, Math.min(DISPATCH_GRACE_MS, remaining() - DISPATCH_POLL_INTERVAL_MS));

  let installId = initialInstallId;
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

  let sends = 0;
  let completedPolls = 0;

  while (remaining() > 0) {
    if (shouldSend) {
      shouldSend = false;
      if (sends >= MAX_DISPATCH_SENDS) {
        // Every resend was authorized by proof the nonce never ran, so at the
        // cap the command still provably has not executed.
        throw fail(
          "undelivered",
          `The dispatch was sent ${sends} times and each send provably never ran (the environment keeps rejecting or losing it before dispatch); the command did not execute`,
          lastError,
        );
      }
      sends += 1;
      const payload = buildDispatchPayload(
        installId,
        nonce,
        command,
        args,
        entryTtl(),
        entryGrace(),
      );
      try {
        const attempt = await ctx.transport({
          ...execOptions,
          allowNonZeroExit: false,
          argv: buildCommandArgv(ctx.vault, DISPATCH_COMMAND, { payload }),
          bin: ctx.bin,
          timeoutMs: budget(DISPATCH_ATTEMPT_TIMEOUT_MS),
        });
        const envelope = parseDispatchEnvelope(attempt.stdout);

        if (envelope?.state === "pending") {
          confirmedRunning = true;
        } else if (envelope === null && !isDispatchVerbNotFound(attempt.stdout)) {
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
          completedPolls = 0;
          shouldSend = true;
          await sleep(Math.max(0, Math.min(DISPATCH_POLL_INTERVAL_MS, remaining())));
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
          // callers that opted into nonzero exits get the outcome, reported
          // against their own command rather than the dispatch internals.
          return {
            argv: directArgv,
            command: ctx.bin,
            exitCode: error.result.exitCode,
            stderr: error.result.stderr,
            stdout: error.result.stdout,
          };
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
        // nonce). Resend.
        completedPolls = 0;
        shouldSend = true;
        await sleep(Math.max(0, Math.min(DISPATCH_POLL_INTERVAL_MS, remaining())));
        continue;
      }
    } catch (error) {
      if (error instanceof ObsidianCommandDispatchError) {
        throw error;
      }
      lastError = error;
    }

    const pollDelayMs = dispatchPollDelayMs(++completedPolls);
    await sleep(Math.max(0, Math.min(pollDelayMs, remaining())));
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
    `No dispatch attempt was acknowledged within ${timeoutMs}ms and no in-app record of the command appeared; it may or may not have started. Resends only happen when the registry proves the nonce never ran, so the command cannot have run twice`,
    lastError,
  );
}
