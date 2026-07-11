import { describe, expect, it } from "vite-plus/test";

import { ObsidianCommandError, ObsidianCommandTimeoutError } from "../../src/core/errors";
import { executeCommand } from "../../src/core/transport";

describe("executeCommand", () => {
  it("captures stdout from a completed command", async () => {
    const result = await executeCommand({
      argv: ["-e", "process.stdout.write('done')"],
      bin: process.execPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done");
  });

  it("throws ObsidianCommandError on nonzero exit with the captured result", async () => {
    const error = await executeCommand({
      argv: ["-e", "process.stderr.write('broken'); process.exit(3)"],
      bin: process.execPath,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ObsidianCommandError);
    expect((error as ObsidianCommandError).result.exitCode).toBe(3);
    expect((error as ObsidianCommandError).result.stderr).toBe("broken");
  });

  // Real child process and wall clock on purpose: this exercises the actual
  // spawn/kill timeout path; fake timers cannot advance a separate process.
  it("kills an overrunning command and rejects with ObsidianCommandTimeoutError", async () => {
    const error = await executeCommand({
      argv: ["-e", "setTimeout(() => {}, 60000)"],
      bin: process.execPath,
      timeoutMs: 150,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ObsidianCommandTimeoutError);
    expect((error as ObsidianCommandTimeoutError).bin).toBe(process.execPath);
    expect((error as ObsidianCommandTimeoutError).argv).toEqual([
      "-e",
      "setTimeout(() => {}, 60000)",
    ]);
    expect((error as ObsidianCommandTimeoutError).timeoutMs).toBe(150);
    expect((error as ObsidianCommandTimeoutError).message).toContain(
      "Command timed out after 150ms",
    );
  });
});
