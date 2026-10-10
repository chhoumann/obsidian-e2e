import path from "node:path";

/**
 * The socket Linux Obsidian and its CLI agree on for an env. The app code is
 * `path.join(process.env.XDG_RUNTIME_DIR || os.homedir(), ".obsidian-cli.sock")`.
 */
export function linuxCliSocket(env: NodeJS.ProcessEnv | undefined): string {
  return path.join(env?.XDG_RUNTIME_DIR || env?.HOME || "", ".obsidian-cli.sock");
}
