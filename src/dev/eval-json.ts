import { randomUUID } from "node:crypto";

import { DevEvalError } from "../core/errors";
import type { DevEvalErrorPayload, ExecOptions, ObsidianDevHandle } from "../core/types";

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

// The serializer and the failure branch are shared verbatim by the synchronous
// and asynchronous builders so both produce the same {ok,value}|{ok:false,error}
// envelope, decoded by the single parseEvalJsonEnvelope path below.
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

const EVAL_JSON_FAILURE_BRANCH =
  "return __obsidianE2EFrame(JSON.stringify({ok:false,error:{message:error instanceof Error?error.message:String(error),name:error instanceof Error?error.name:'Error',stack:error instanceof Error?error.stack:undefined}}));";

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

export async function runEvalJsonAsync<T>(
  dev: Pick<ObsidianDevHandle, "evalRaw">,
  code: string,
  execOptions: ExecOptions = {},
): Promise<T> {
  const frame = createEvalJsonFrame();

  return parseEvalJsonEnvelope<T>(
    await dev.evalRaw(buildEvalJsonAsyncCode(code, frame), execOptions),
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

export function buildEvalJsonAsyncCode(code: string, frame: EvalJsonFrame): string {
  // Indirect `eval` parses its argument as a script, where a top-level `await`
  // is a SyntaxError. Wrapping the caller's code as the expression body of an
  // async arrow makes `await` valid while still yielding the expression's value,
  // so both `await load()` and a plain promise-returning expression work.
  const asyncExpression = `(async()=>(${code}))()`;
  return [
    "(async()=>{",
    `const __obsidianE2ECode=${JSON.stringify(asyncExpression)};`,
    buildFrameHelper(frame),
    EVAL_JSON_SERIALIZER,
    "try{",
    "return __obsidianE2EFrame(JSON.stringify({ok:true,value:__obsidianE2ESerialize(await (0,eval)(__obsidianE2ECode))}));",
    "}catch(error){",
    EVAL_JSON_FAILURE_BRANCH,
    "}",
    "})()",
  ].join("");
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
