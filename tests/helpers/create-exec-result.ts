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
