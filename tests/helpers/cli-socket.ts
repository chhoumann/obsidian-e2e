import path from "node:path";

/**
 * The socket Linux Obsidian and its CLI agree on for an env. The app code is
 * `path.join(process.env.XDG_RUNTIME_DIR || os.homedir(), ".obsidian-cli.sock")`.
 */
export function linuxCliSocket(env: NodeJS.ProcessEnv | undefined): string {
  return path.join(env?.XDG_RUNTIME_DIR || env?.HOME || "", ".obsidian-cli.sock");
}

/** The compositor socket libwayland's `wl_display_connect(NULL)` resolves for an env. */
export function waylandSocket(env: NodeJS.ProcessEnv | undefined): string {
  const display = env?.WAYLAND_DISPLAY ?? "wayland-0";
  return path.isAbsolute(display) ? display : path.join(env?.XDG_RUNTIME_DIR ?? "", display);
}
