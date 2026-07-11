import type { ExecResult } from "../../src/core/types";

export function createExecResult(command: string, argv: string[], stdout: string): ExecResult {
  return {
    argv,
    command,
    exitCode: 0,
    stderr: "",
    stdout,
  };
}

/**
 * Wrap a stubbed eval payload in the per-call envelope frame embedded in the
 * generated evalJson code, mirroring what the real generated code returns.
 * Unframed eval code (dev.eval / evalRaw callers) passes through untouched.
 */
export function frameEvalPayload(code: string, payload: string): string {
  const match = /<<obsidian-e2e:[^:>]+:begin>>/u.exec(code);

  if (!match) {
    return payload;
  }

  return `${match[0]}${payload}${match[0].replace(":begin>>", ":end>>")}`;
}
