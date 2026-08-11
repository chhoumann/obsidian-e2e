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
/**
 * The spawned CLI process exceeded its time budget and was killed. The command
 * may still have been delivered to (and executed by) the running app - only the
 * reply is known to be lost.
 */
export class ObsidianCommandTimeoutError extends Error {
  readonly argv: string[];
  readonly bin: string;
  readonly timeoutMs: number;

  constructor(bin: string, argv: string[], timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms: ${bin} ${argv.join(" ")}`);
    this.name = "ObsidianCommandTimeoutError";
    this.argv = argv;
    this.bin = bin;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Failure taxonomy for the kickoff-and-poll `evalJsonAsync` protocol. Each
 * reason names a distinct, observed transport state instead of a generic
 * timeout:
 *
 * - `ambiguous-delivery`: the kickoff command failed or its reply was lost,
 *   and no in-app record of the operation appeared before the deadline. It may
 *   or may not have started; the kickoff is never resent (there is no
 *   structural delivery acknowledgement), so the code cannot run twice.
 * - `context-reset`: the eval context was confirmed running and then vanished
 *   (e.g. an app/vault reload wiped the renderer); the result was discarded
 *   with the previous context.
 * - `still-pending`: the operation is confirmed running but its promise has not
 *   settled within the deadline. It may still complete in-app afterwards.
 */
export type DevEvalAsyncFailureReason = "ambiguous-delivery" | "context-reset" | "still-pending";

export class DevEvalAsyncError extends Error {
  readonly causeError?: unknown;
  readonly nonce: string;
  readonly reason: DevEvalAsyncFailureReason;

  constructor(
    message: string,
    reason: DevEvalAsyncFailureReason,
    nonce: string,
    causeError?: unknown,
  ) {
    super(message);
    this.name = "DevEvalAsyncError";
    this.reason = reason;
    this.nonce = nonce;
    this.causeError = causeError;
  }
}

/**
 * Failure taxonomy for the recoverable `exec()` dispatch protocol. Extends the
 * `evalJsonAsync` taxonomy with `undelivered` - unlike an eval kickoff, a
 * dispatch that was never sent (the shim could not be installed) is *provably*
 * unexecuted, and callers may safely retry:
 *
 * - `ambiguous-delivery`: no dispatch attempt was acknowledged and no in-app
 *   record appeared before the deadline. The command may or may not have
 *   started; the nonce was never re-dispatched, so it cannot have run twice.
 * - `context-reset`: the renderer context was reset (e.g. an app or vault
 *   reload) while an attempt with unknown fate was in flight; whether the
 *   command executed before the reset is unknowable.
 * - `still-pending`: the command is confirmed running in-app but its handler
 *   has not settled within the deadline. It may still complete afterwards.
 * - `undelivered`: the dispatch shim could not be installed (or disappeared
 *   before any attempt was acknowledged); the command was never dispatched
 *   and did not run.
 */
export type ObsidianCommandDispatchFailureReason =
  | "ambiguous-delivery"
  | "context-reset"
  | "still-pending"
  | "undelivered";

export class ObsidianCommandDispatchError extends Error {
  readonly argv: string[];
  readonly causeError?: unknown;
  readonly nonce: string;
  readonly reason: ObsidianCommandDispatchFailureReason;

  constructor(
    message: string,
    reason: ObsidianCommandDispatchFailureReason,
    nonce: string,
    argv: string[],
    causeError?: unknown,
  ) {
    super(message);
    this.name = "ObsidianCommandDispatchError";
    this.reason = reason;
    this.nonce = nonce;
    this.argv = argv;
    this.causeError = causeError;
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
