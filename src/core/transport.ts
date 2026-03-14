import { spawn } from "node:child_process";

import { ObsidianCommandError } from "./errors";
import type { CommandTransport, ExecuteRequest, ExecResult } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;

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

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(Buffer.from(chunk));
  });

  child.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${bin} ${argv.join(" ")}`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
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
