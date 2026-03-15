import type { ExecResult } from "./types";
import type { DevEvalErrorPayload } from "./types";

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

export class DevEvalError extends Error {
  readonly remote: DevEvalErrorPayload;

  constructor(message: string, remote: DevEvalErrorPayload) {
    super(message);
    this.name = "DevEvalError";
    this.remote = remote;

    if (remote.stack) {
      this.stack = `${this.name}: ${message}\nRemote stack:\n${remote.stack}`;
    }
  }
}
