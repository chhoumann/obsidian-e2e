import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import type { ExecFileFn } from "../launch";

const execFileAsync = promisify(execFileCb);

/** The production child-process boundary for adb/emulator commands. */
export const execFileAdb: ExecFileFn = async (file, args, options = {}) => {
  const { stdout, stderr } = (await execFileAsync(file, [...args], {
    encoding: "utf8",
    env: options.env,
    timeout: options.timeout,
    // adb `push` of a large main.js prints progress; keep a roomy buffer.
    maxBuffer: 16 * 1024 * 1024,
  })) as { stdout: string; stderr: string };
  return { stdout, stderr };
};
