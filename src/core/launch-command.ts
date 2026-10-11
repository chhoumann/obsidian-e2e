import path from "node:path";
import process from "node:process";

export const DEFAULT_XVFB_SCREEN = "3840x3200x24";
/** Set in the app's environment when it runs on a private Xvfb display. */
export const DEDICATED_DISPLAY_ENV = "OBSIDIAN_E2E_CAPTURE_XVFB";

export interface LaunchCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export function defaultObsidianExecutable(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
  if (platform === "linux") return "/opt/Obsidian/obsidian";
  throw new Error(
    `No default Obsidian executable for ${platform} (untested platform); pass --obsidian-app <path>`,
  );
}

interface XvfbOptions {
  platform: NodeJS.Platform;
  xvfb?: boolean;
  screen?: string;
  authDir: string;
}

// Without -f, xvfb-run makes a temp dir whose EXIT trap does not run on SIGTERM.
const AUTH_FILE = "Xauthority";
const RESTORE_AUTH_AND_CWD = 'export XAUTHORITY="$1" && cd "$2" && shift 2 && exec "$@"';

export function withXvfb(command: LaunchCommand, options: XvfbOptions): LaunchCommand {
  const useXvfb = options.xvfb ?? (options.platform === "linux" && !command.env.DISPLAY);
  if (!useXvfb) return command;
  return {
    file: "xvfb-run",
    args: [
      "-a",
      "-f",
      AUTH_FILE,
      "-s",
      `-screen 0 ${options.screen ?? DEFAULT_XVFB_SCREEN}`,
      "/bin/sh",
      "-c",
      RESTORE_AUTH_AND_CWD,
      "sh",
      path.join(options.authDir, AUTH_FILE),
      command.cwd ?? process.cwd(),
      command.file,
      ...command.args,
    ],
    // Marks a private display nothing else draws on: `record --backend auto`
    // only picks x11grab there (see detectX11Target).
    env: withoutWayland({ ...command.env, [DEDICATED_DISPLAY_ENV]: "1" }),
    // xvfb-run passes Xvfb `-auth $AUTHFILE` unquoted, which splits a path with
    // spaces, so it runs here with a relative auth file.
    cwd: options.authDir,
  };
}

/** Under Xvfb the app must not see (or prefer) an outer Wayland session. */
function withoutWayland(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { WAYLAND_DISPLAY: _wayland, WAYLAND_SOCKET: _socket, ...rest } = env;
  return { ...rest, XDG_SESSION_TYPE: "x11" };
}
