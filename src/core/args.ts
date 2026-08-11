import type { ObsidianArg } from "./types";

export function buildCommandArgv(
  vaultName: string,
  command: string,
  args: Record<string, ObsidianArg> = {},
): string[] {
  return [`vault=${vaultName}`, command, ...buildArgTokens(args)];
}

/**
 * The `key=value` tokens after the command, without the `vault=` prefix - the
 * shape `window.handleCli` receives in-app (the main process consumes the
 * vault token before relaying argv).
 */
export function buildArgTokens(args: Record<string, ObsidianArg> = {}): string[] {
  const tokens: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (value === false || value === null || value === undefined) {
      continue;
    }

    if (value === true) {
      tokens.push(key);
      continue;
    }

    tokens.push(`${key}=${String(value)}`);
  }

  return tokens;
}
