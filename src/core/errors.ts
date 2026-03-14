import type { ExecResult } from "./types";

export class ObsidianCommandError extends Error {
  readonly result: ExecResult;

  constructor(message: string, result: ExecResult) {
    super(message);
    this.name = "ObsidianCommandError";
    this.result = result;
  }
}

export class WaitForTimeoutError extends Error {
  readonly causeError?: unknown;

  constructor(message: string, causeError?: unknown) {
    super(message);
    this.name = "WaitForTimeoutError";
    this.causeError = causeError;
  }
}
