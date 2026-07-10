/**
 * Shared argument-parsing machinery for the runner subcommands. Each subcommand
 * supplies an explicit flag -> option-key mapping; nothing is derived from
 * `slice(2)`, so a flag whose key is not its camelCased suffix stays correct.
 */

export interface ArgsParserSpec {
  /** Maps a value flag (`"--vault"`) to its result key (`"vault"`). */
  valueOptions: Record<string, string>;
  /** Maps a boolean flag (`"--force"`) to its result key (`"force"`). */
  booleanOptions: Record<string, string>;
}

export interface ParsedArgs {
  options: Record<string, string | boolean>;
  /**
   * Tokens after the end of options: everything following a bare `--`
   * terminator, or the first non-option token and everything after it.
   */
  rest: string[];
}

/** Shared value flags used by every subcommand. */
export const SHARED_VALUE_OPTIONS: Record<string, string> = {
  "--vault": "vault",
  "--root": "root",
  "--worktree": "worktree",
  "--data": "data",
  "--profile-root": "profileRoot",
  "--obsidian-app": "obsidianApp",
  "--obsidian-bin": "obsidianBin",
  "--config": "config",
};

/** Shared boolean flags used by every subcommand. */
export const SHARED_BOOLEAN_OPTIONS: Record<string, string> = {
  "--force": "force",
  "--json": "json",
  "--help": "help",
};

export function parseArgs(argv: string[], spec: ArgsParserSpec): ParsedArgs {
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === "--") {
      // A leading `--` immediately followed by one of our own flags is
      // package-manager noise, not a terminator: `pnpm run <script> -- --print-env`
      // (and the npm equivalent) forward the literal `--` ahead of the script
      // args, so dropping everything after it would silently swallow `--print-env`
      // and friends. Skip that separator and keep parsing options. A `--` anywhere
      // else - or one followed by the forwarded command - stays a true
      // end-of-options terminator.
      const next = argv[index + 1];
      const nextIsOwnFlag =
        next !== undefined &&
        (spec.booleanOptions[next] !== undefined || spec.valueOptions[next] !== undefined);
      if (index === 0 && nextIsOwnFlag) {
        continue;
      }
      return { options, rest: argv.slice(index + 1) };
    }

    const booleanKey = spec.booleanOptions[arg];
    if (booleanKey !== undefined) {
      options[booleanKey] = true;
      continue;
    }

    const valueKey = spec.valueOptions[arg];
    if (valueKey !== undefined) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      options[valueKey] = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    // First non-option token starts the forwarded command.
    return { options, rest: argv.slice(index) };
  }

  return { options, rest: [] };
}

/** Bind a spec so callers can parse repeatedly without re-passing it. */
export function createArgsParser(spec: ArgsParserSpec): (argv: string[]) => ParsedArgs {
  return (argv) => parseArgs(argv, spec);
}
