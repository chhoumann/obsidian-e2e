export const DEFAULT_XVFB_SCREEN = "3840x3200x24";
/** Set in the app's environment when it runs on a private Xvfb display. */
export const DEDICATED_DISPLAY_ENV = "OBSIDIAN_E2E_CAPTURE_XVFB";

export interface LaunchCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
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
  /**
   * Inside a directory the caller removes. Without one, xvfb-run makes a temp
   * dir that only its EXIT trap deletes, and a SIGTERM skips that trap.
   */
  authFile: string;
}

export function withXvfb(command: LaunchCommand, options: XvfbOptions): LaunchCommand {
  const useXvfb = options.xvfb ?? (options.platform === "linux" && !command.env.DISPLAY);
  if (!useXvfb) return command;
  return {
    file: "xvfb-run",
    args: [
      "-a",
      "-f",
      options.authFile,
      "-s",
      `-screen 0 ${options.screen ?? DEFAULT_XVFB_SCREEN}`,
      command.file,
      ...command.args,
    ],
    // Marks a private display nothing else draws on: `record --backend auto`
    // only picks x11grab there (see detectX11Target).
    env: withoutWayland({ ...command.env, [DEDICATED_DISPLAY_ENV]: "1" }),
  };
}

/** Under Xvfb the app must not see (or prefer) an outer Wayland session. */
function withoutWayland(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { WAYLAND_DISPLAY: _wayland, WAYLAND_SOCKET: _socket, ...rest } = env;
  return { ...rest, XDG_SESSION_TYPE: "x11" };
}
