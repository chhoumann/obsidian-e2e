import { randomUUID } from "node:crypto";

import { DevEvalAsyncError, DevEvalError, type DevEvalAsyncFailureReason } from "../core/errors";
import type { DevEvalErrorPayload, ExecOptions, ObsidianDevHandle } from "../core/types";
import { sleep } from "../core/wait";

interface EvalJsonSuccess {
  ok: true;
  value: unknown;
}

interface EvalJsonFailure {
  error: DevEvalErrorPayload;
  ok: false;
}

type EvalJsonEnvelope = EvalJsonFailure | EvalJsonSuccess;

interface UndefinedSentinel {
  __obsidianE2EType: "undefined";
}

/**
 * Per-call sentinel markers wrapped around the JSON envelope. The eval channel
 * is shared with whatever the plugin prints while the evaluated code runs, so
 * any plugin that logs during the exercised operation would otherwise corrupt
 * the response (`Unexpected token 'Q', "QuickAdd: "... is not valid JSON`).
 * A fresh nonce per call keeps a marker collision with logged output or with
 * the serialized value itself out of the failure space.
 */
export interface EvalJsonFrame {
  begin: string;
  end: string;
}

export function createEvalJsonFrame(): EvalJsonFrame {
  const nonce = randomUUID();

  return {
    begin: `<<obsidian-e2e:${nonce}:begin>>`,
    end: `<<obsidian-e2e:${nonce}:end>>`,
  };
}

// The serializer and the error payload are shared verbatim by the synchronous
// builder and the async kickoff builder so both produce the same
// {ok,value}|{ok:false,error} envelope, decoded by the single
// unwrapEvalJsonEnvelope path below.
const EVAL_JSON_SERIALIZER = [
  "const __obsidianE2ESerialize=(value,path='$')=>{",
  "if(value===null){return null;}",
  "if(value===undefined){return {__obsidianE2EType:'undefined'};}",
  "const valueType=typeof value;",
  "if(valueType==='string'||valueType==='boolean'){return value;}",
  "if(valueType==='number'){if(!Number.isFinite(value)){throw new Error(`Cannot serialize non-finite number at ${path}.`);}return value;}",
  "if(valueType==='bigint'||valueType==='function'||valueType==='symbol'){throw new Error(`Cannot serialize ${valueType} at ${path}.`);}",
  "if(Array.isArray(value)){return value.map((item,index)=>__obsidianE2ESerialize(item,`${path}[${index}]`));}",
  "const prototype=Object.getPrototypeOf(value);",
  "if(prototype!==Object.prototype&&prototype!==null){throw new Error(`Cannot serialize non-plain object at ${path}.`);}",
  "const next={};",
  "for(const [key,entry] of Object.entries(value)){next[key]=__obsidianE2ESerialize(entry,`${path}.${key}`);}",
  "return next;",
  "};",
].join("");

const EVAL_JSON_ERROR_PAYLOAD =
  "{message:error instanceof Error?error.message:String(error),name:error instanceof Error?error.name:'Error',stack:error instanceof Error?error.stack:undefined}";

const EVAL_JSON_FAILURE_BRANCH = `return __obsidianE2EFrame(JSON.stringify({ok:false,error:${EVAL_JSON_ERROR_PAYLOAD}}));`;

function buildFrameHelper(frame: EvalJsonFrame): string {
  return `const __obsidianE2EFrame=(payload)=>${JSON.stringify(frame.begin)}+payload+${JSON.stringify(frame.end)};`;
}

export async function runEvalJson<T>(
  dev: Pick<ObsidianDevHandle, "evalRaw">,
  code: string,
  execOptions: ExecOptions = {},
): Promise<T> {
  const frame = createEvalJsonFrame();

  return parseEvalJsonEnvelope<T>(
    await dev.evalRaw(buildEvalJsonCode(code, frame), execOptions),
    frame,
  );
}

export function buildEvalJsonCode(code: string, frame: EvalJsonFrame): string {
  return [
    "(()=>{",
    `const __obsidianE2ECode=${JSON.stringify(code)};`,
    buildFrameHelper(frame),
    EVAL_JSON_SERIALIZER,
    "try{",
    "return __obsidianE2EFrame(JSON.stringify({ok:true,value:__obsidianE2ESerialize((0,eval)(__obsidianE2ECode))}));",
    "}catch(error){",
    EVAL_JSON_FAILURE_BRANCH,
    "}",
    "})()",
  ].join("");
}

/**
 * In-app registry for the kickoff-and-poll `evalJsonAsync` protocol. The
 * `obsidian eval` CLI command holds a single socket request open for the whole
 * lifetime of an awaited promise, and its reply is the only carrier of the
 * result - a client-side timeout kill or a renderer reload mid-eval loses the
 * value forever even when the operation itself completed (#21). The protocol
 * below keeps every CLI command short instead: a kickoff command starts the
 * operation and records its eventual envelope under a per-operation nonce, and
 * idempotent poll reads retrieve it, so a lost reply is recoverable by reading
 * again.
 */
const ASYNC_EVAL_REGISTRY = "__obsidianE2EAsyncEvals";

const ASYNC_EVAL_POLL_INTERVAL_MS = 100;
/** Budget for each internal CLI command; polls make long waits out of short reads. */
const ASYNC_EVAL_COMMAND_TIMEOUT_MS = 10_000;
/** Best-effort cleanup only; never worth stalling a passed test for. */
const ASYNC_EVAL_CLEANUP_TIMEOUT_MS = 2_000;
/** Mirrors the transport's default command timeout, which bounded the old single-command form. */
const DEFAULT_ASYNC_EVAL_TIMEOUT_MS = 30_000;

interface AsyncEvalDoneEntry {
  envelope: EvalJsonEnvelope;
  state: "done";
}

interface AsyncEvalPendingEntry {
  state: "pending";
}

type AsyncEvalEntry = AsyncEvalDoneEntry | AsyncEvalPendingEntry;

/**
 * Kickoff command: registers `{state:'pending'}` under the nonce synchronously,
 * starts the awaited operation, and returns immediately. The completion handler
 * stores the same `{ok,value}|{ok:false,error}` envelope the synchronous
 * builder produces (serialization happens at completion time, so a
 * non-serializable resolution becomes a stored error envelope).
 */
export function buildEvalJsonAsyncKickoffCode(
  code: string,
  frame: EvalJsonFrame,
  nonce: string,
): string {
  // Indirect `eval` parses its argument as a script, where a top-level `await`
  // is a SyntaxError. Wrapping the caller's code as the expression body of an
  // async arrow makes `await` valid while still yielding the expression's value,
  // so both `await load()` and a plain promise-returning expression work.
  const asyncExpression = `(async()=>(${code}))()`;
  return [
    "(()=>{",
    `const __obsidianE2ECode=${JSON.stringify(asyncExpression)};`,
    buildFrameHelper(frame),
    EVAL_JSON_SERIALIZER,
    `const __obsidianE2ERegistry=globalThis.${ASYNC_EVAL_REGISTRY}??(globalThis.${ASYNC_EVAL_REGISTRY}=Object.create(null));`,
    `const __obsidianE2ENonce=${JSON.stringify(nonce)};`,
    "__obsidianE2ERegistry[__obsidianE2ENonce]={state:'pending'};",
    "(async()=>{",
    "try{return {ok:true,value:__obsidianE2ESerialize(await (0,eval)(__obsidianE2ECode))};}",
    `catch(error){return {ok:false,error:${EVAL_JSON_ERROR_PAYLOAD}};}`,
    "})().then((envelope)=>{__obsidianE2ERegistry[__obsidianE2ENonce]={state:'done',envelope};});",
    "return __obsidianE2EFrame(JSON.stringify({ok:true,value:'started'}));",
    "})()",
  ].join("");
}

/** Pure read; safe to repeat after any lost or failed reply. */
export function buildEvalJsonAsyncPollCode(nonce: string): string {
  return `globalThis.${ASYNC_EVAL_REGISTRY}?.[${JSON.stringify(nonce)}]??null`;
}

export function buildEvalJsonAsyncCleanupCode(nonce: string): string {
  return `(()=>{const registry=globalThis.${ASYNC_EVAL_REGISTRY};if(registry){delete registry[${JSON.stringify(nonce)}];}return true;})()`;
}

export async function runEvalJsonAsync<T>(
  dev: Pick<ObsidianDevHandle, "evalRaw">,
  code: string,
  execOptions: ExecOptions = {},
): Promise<T> {
  const timeoutMs = execOptions.timeoutMs ?? DEFAULT_ASYNC_EVAL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const nonce = randomUUID();

  // Spread the resolved options so cwd/env flow into every internal command;
  // allowNonZeroExit is forced off so CLI failures classify as failures, and
  // timeoutMs becomes the per-command budget clamped to the overall deadline.
  const commandOptions = (budgetMs: number): ExecOptions => ({
    ...execOptions,
    allowNonZeroExit: false,
    timeoutMs: Math.max(1, Math.min(budgetMs, deadline - Date.now())),
  });
  const pause = async () => {
    await sleep(Math.max(0, Math.min(ASYNC_EVAL_POLL_INTERVAL_MS, deadline - Date.now())));
  };
  const fail = (reason: DevEvalAsyncFailureReason, message: string, causeError?: unknown) =>
    new DevEvalAsyncError(`${message} (nonce ${nonce})`, reason, nonce, causeError);

  // Kickoff phase: sent exactly once, ever. There is no structural delivery
  // acknowledgement other than the framed reply itself, so any failure here
  // leaves delivery unknown and the idempotent poll phase below doubles as the
  // probe. Never resending is what makes exactly-once execution literal.
  let confirmed = false;
  let lastError: unknown;

  const kickoffFrame = createEvalJsonFrame();
  try {
    parseEvalJsonEnvelope<string>(
      await dev.evalRaw(
        buildEvalJsonAsyncKickoffCode(code, kickoffFrame, nonce),
        commandOptions(ASYNC_EVAL_COMMAND_TIMEOUT_MS),
      ),
      kickoffFrame,
    );
    confirmed = true;
  } catch (error) {
    lastError = error;
  }

  // Poll phase: idempotent reads until the envelope appears or the deadline
  // names the precise terminal state.
  while (Date.now() < deadline) {
    let entry: AsyncEvalEntry | null;
    try {
      entry = await runEvalJson<AsyncEvalEntry | null>(
        dev,
        buildEvalJsonAsyncPollCode(nonce),
        commandOptions(ASYNC_EVAL_COMMAND_TIMEOUT_MS),
      );
    } catch (error) {
      lastError = error;
      await pause();
      continue;
    }

    if (entry === null) {
      if (confirmed) {
        throw fail(
          "context-reset",
          "The Obsidian eval context was reset (e.g. an app or vault reload) while the evalJsonAsync operation was running; its result was discarded with the previous context",
        );
      }
      // Kickoff reply was lost and the operation has not (yet) appeared: the
      // kickoff may still be in transit, so keep probing until the deadline.
    } else {
      confirmed = true;
      if (entry.state === "done") {
        try {
          await runEvalJson<boolean>(
            dev,
            buildEvalJsonAsyncCleanupCode(nonce),
            commandOptions(ASYNC_EVAL_CLEANUP_TIMEOUT_MS),
          );
        } catch {
          // Best-effort: a leaked entry is one small object in the renderer.
        }
        return unwrapEvalJsonEnvelope<T>(entry.envelope);
      }
    }

    await pause();
  }

  if (confirmed) {
    throw fail(
      "still-pending",
      `The evalJsonAsync operation is still pending in Obsidian after ${timeoutMs}ms; the awaited promise has not settled. It may still complete in-app`,
    );
  }

  throw fail(
    "ambiguous-delivery",
    `The evalJsonAsync kickoff command failed or its reply was lost, and no in-app record of the operation appeared within ${timeoutMs}ms; it may or may not have started. The kickoff was not resent, so the code cannot have run twice`,
    lastError,
  );
}

export function parseDevEvalOutput<T>(raw: string): T {
  const normalized = normalizeEvalOutput(raw);

  try {
    return JSON.parse(normalized) as T;
  } catch {
    return normalized as T;
  }
}

export function parseEvalJsonEnvelope<T>(raw: string, frame?: EvalJsonFrame): T {
  const payload = frame ? extractFramedPayload(raw, frame) : normalizeEvalOutput(raw);
  const envelope = JSON.parse(payload) as EvalJsonEnvelope;

  return unwrapEvalJsonEnvelope<T>(envelope);
}

function unwrapEvalJsonEnvelope<T>(envelope: EvalJsonEnvelope): T {
  if (!envelope.ok) {
    throw new DevEvalError(`Failed to evaluate Obsidian code: ${envelope.error.message}`, {
      ...envelope.error,
    });
  }

  return decodeEvalJsonValue(envelope.value) as T;
}

function extractFramedPayload(raw: string, frame: EvalJsonFrame): string {
  // First begin / last end: the envelope is a single write, so the real begin
  // marker precedes any inner occurrence of the marker text in the serialized
  // value, and the real end marker follows it. The per-call nonce keeps
  // surrounding plugin output from ever containing either marker.
  const beginIndex = raw.indexOf(frame.begin);
  const endIndex = raw.lastIndexOf(frame.end);

  if (beginIndex === -1 || endIndex < beginIndex + frame.begin.length) {
    const excerpt = raw.length > 2_000 ? `${raw.slice(0, 2_000)}… (${raw.length} chars)` : raw;
    throw new Error(
      `Obsidian eval output did not contain the framed JSON result envelope. Raw output: ${excerpt}`,
    );
  }

  return raw.slice(beginIndex + frame.begin.length, endIndex);
}

function normalizeEvalOutput(raw: string): string {
  return raw.startsWith("=> ") ? raw.slice(3) : raw;
}

function decodeEvalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => decodeEvalJsonValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (isUndefinedSentinel(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decodeEvalJsonValue(entry)]),
  );
}

function isUndefinedSentinel(value: object): value is UndefinedSentinel {
  return "__obsidianE2EType" in value && value.__obsidianE2EType === "undefined";
}
