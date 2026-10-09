import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";

import { ObsidianCommandError, ObsidianCommandTimeoutError } from "./errors";
import type { CommandTransport, ExecuteRequest, ExecResult } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Vitest stops a forks worker with SIGTERM, whose default action skips timers
 * and `exit` handlers, so a client still in flight would outlive the worker.
 */
const liveClients = new Set<ChildProcess>();

function killLiveClientsOnSigterm(): void {
  for (const child of liveClients) {
    child.kill("SIGTERM");
  }

  liveClients.clear();
  process.off("SIGTERM", killLiveClientsOnSigterm);

  // With no other listener left, re-raising runs the default action (terminate)
  // exactly as if this listener had never been attached.
  if (process.listenerCount("SIGTERM") === 0) {
    process.kill(process.pid, "SIGTERM");
  }
}

function trackClient(child: ChildProcess): void {
  if (liveClients.size === 0) {
    process.prependListener("SIGTERM", killLiveClientsOnSigterm);
  }

  liveClients.add(child);

  const untrack = () => {
    liveClients.delete(child);

    if (liveClients.size === 0) {
      process.off("SIGTERM", killLiveClientsOnSigterm);
    }
  };

  child.once("exit", untrack).once("error", untrack);
}

export const executeCommand: CommandTransport = async ({
  allowNonZeroExit = false,
  argv,
  bin,
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ExecuteRequest): Promise<ExecResult> => {
  const child = spawn(bin, argv, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackClient(child);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(Buffer.from(chunk));
  });

  child.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  // Executor form on purpose: `Promise.withResolvers` is ES2024/Node >= 22,
  // and the package's engines floor is Node ^20.19.0.
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ObsidianCommandTimeoutError(bin, argv, timeoutMs));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(shellExitCode(code, signal));
    });
  });

  const result: ExecResult = {
    argv,
    command: bin,
    exitCode,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
  };

  if (exitCode !== 0 && !allowNonZeroExit) {
    throw new ObsidianCommandError(
      `Obsidian command failed with exit code ${exitCode}: ${bin} ${argv.join(" ")}`,
      result,
    );
  }

  return result;
};

function shellExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  return signal ? 128 + constants.signals[signal] : (code ?? 0);
}
