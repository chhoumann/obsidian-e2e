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

export async function runEvalJson<T>(
  dev: Pick<ObsidianDevHandle, "evalRaw">,
  code: string,
  execOptions: ExecOptions = {},
): Promise<T> {
  return parseEvalJsonEnvelope<T>(await dev.evalRaw(buildEvalJsonCode(code), execOptions));
}

export function buildEvalJsonCode(code: string): string {
  return [
    "(()=>{",
    `const __obsidianE2ECode=${JSON.stringify(code)};`,
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
    "try{",
    "return JSON.stringify({ok:true,value:__obsidianE2ESerialize((0,eval)(__obsidianE2ECode))});",
    "}catch(error){",
    "return JSON.stringify({ok:false,error:{message:error instanceof Error?error.message:String(error),name:error instanceof Error?error.name:'Error',stack:error instanceof Error?error.stack:undefined}});",
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

export function parseEvalJsonEnvelope<T>(raw: string): T {
  const envelope = JSON.parse(normalizeEvalOutput(raw)) as EvalJsonEnvelope;

  if (!envelope.ok) {
    throw new DevEvalError(`Failed to evaluate Obsidian code: ${envelope.error.message}`, {
      ...envelope.error,
    });
  }

  return decodeEvalJsonValue(envelope.value) as T;
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
