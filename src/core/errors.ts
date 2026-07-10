import type { ExecResult } from "./types";
import type { DevEvalErrorPayload } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorHasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** Extract the useful output attached to a rejected child-process command. */
export function commandErrorMessage(error: unknown): string {
  if (isRecord(error)) {
    if (typeof error.stderr === "string" && error.stderr.trim()) {
      return error.stderr.trim();
    }
    if (typeof error.stdout === "string" && error.stdout.trim()) {
      return error.stdout.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}

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
