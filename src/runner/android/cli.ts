import path from "node:path";
import process from "node:process";

import { SHARED_BOOLEAN_OPTIONS, parseArgs, type ArgsParserSpec, type ParsedArgs } from "../args";
import { loadRunnerConfig as realLoadRunnerConfig } from "../config";
import { slugify, toShellExports, type ShellExport } from "../fs-utils";
import type { ResolvedRunnerConfig } from "../types";
import { execFileAdb } from "./exec";
import {
  ensureAndroidInstance as realEnsureAndroidInstance,
  stopAndroidInstance as realStopAndroidInstance,
  type AndroidEnsureDependencies,
  type AndroidEnsureResult,
  type AndroidOptions,
} from "./ensure";
import { CdpClient } from "./cdp";

const ANDROID_SUBCOMMANDS = ["start", "stop", "run"] as const;
type AndroidSubcommand = (typeof ANDROID_SUBCOMMANDS)[number];

/**
 * The android family shares the desktop flags that still mean something on a
 * device (vault name, worktree, data seed, config) and drops the ones that are
 * host-filesystem concepts (root, profile-root, obsidian-app, obsidian-bin).
 */
const ANDROID_VALUE_OPTIONS: Record<string, string> = {
  "--vault": "vault",
  "--worktree": "worktree",
  "--data": "data",
  "--config": "config",
};

const ANDROID_SPEC: ArgsParserSpec = {
  valueOptions: ANDROID_VALUE_OPTIONS,
  booleanOptions: { ...SHARED_BOOLEAN_OPTIONS, "--print-env": "printEnv" },
};

/** All boundaries the android CLI touches, injected so it is testable end to end. */
export interface AndroidCliDependencies {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  loadRunnerConfig?: typeof realLoadRunnerConfig;
  ensureAndroidInstance?: typeof realEnsureAndroidInstance;
  stopAndroidInstance?: typeof realStopAndroidInstance;
  connectCdp?: typeof CdpClient.connect;
  ensureDeps?: AndroidEnsureDependencies;
}

/** Resolve the shared android options from parsed flags; mirrors the desktop naming. */
export function resolveAndroidOptions(
  parsed: ParsedArgs,
  config: ResolvedRunnerConfig,
  cwd: string,
): AndroidOptions {
  const worktreePath = path.resolve(cwd, asString(parsed.options.worktree) ?? ".");
  const vaultName =
    asString(parsed.options.vault) ??
    `${config.vaultPrefix}-${slugify(path.basename(worktreePath))}`;
  const data = asString(parsed.options.data);
  return {
    vaultName,
    worktreePath,
    dataPath: data ? path.resolve(cwd, data) : undefined,
    json: parsed.options.json === true,
    printEnv: parsed.options.printEnv === true,
  };
}

/** Render the `--print-env` exports for an android instance. */
export function androidShellExports(
  result: AndroidEnsureResult,
  config: ResolvedRunnerConfig,
): string {
  const exports: ShellExport[] = [
    { name: "OBSIDIAN_E2E_ANDROID_SERIAL", value: result.serial },
    { name: "OBSIDIAN_E2E_ANDROID_CDP_PORT", value: String(result.cdpPort) },
    { name: "OBSIDIAN_E2E_ANDROID_VAULT", value: result.vaultName },
    { name: "OBSIDIAN_E2E_ANDROID_VAULT_PATH", value: result.vaultPath },
  ];
  if (config.envPrefix) {
    exports.push(
      { name: `${config.envPrefix}_E2E_ANDROID_SERIAL`, value: result.serial },
      { name: `${config.envPrefix}_E2E_ANDROID_CDP_PORT`, value: String(result.cdpPort) },
      { name: `${config.envPrefix}_E2E_ANDROID_VAULT`, value: result.vaultName },
      { name: `${config.envPrefix}_E2E_ANDROID_VAULT_PATH`, value: result.vaultPath },
    );
  }
  return toShellExports(exports);
}

/**
 * Route `android <start|stop|run>`. Loads the worktree config itself (its
 * `--config`/`--worktree` flags live after the sub-subcommand, so the parent
 * router cannot). Requires the config's `android` block; the error for a
 * missing block names the one field (`avd`) needed to add it.
 */
export async function runAndroidCli(
  argv: readonly string[],
  deps: AndroidCliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const err = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const emit = (write: (text: string) => void, line: string) => write(`${line}\n`);

  const [maybeSubcommand, ...rest] = argv;
  if (maybeSubcommand === undefined || maybeSubcommand === "--help" || maybeSubcommand === "-h") {
    emit(out, androidHelp());
    return 0;
  }
  if (!(ANDROID_SUBCOMMANDS as readonly string[]).includes(maybeSubcommand)) {
    emit(err, `Unknown android command: ${maybeSubcommand}`);
    emit(err, androidHelp());
    return 1;
  }
  const subcommand = maybeSubcommand as AndroidSubcommand;

  const parsed = parseArgs([...rest], ANDROID_SPEC);
  if (parsed.options.help === true) {
    emit(out, androidHelp());
    return 0;
  }

  const cwd = deps.cwd ?? process.cwd();
  const loadRunnerConfig = deps.loadRunnerConfig ?? realLoadRunnerConfig;
  const worktreePath = path.resolve(cwd, asString(parsed.options.worktree) ?? ".");
  const config = await loadRunnerConfig(worktreePath, asString(parsed.options.config));

  const android = config.android;
  if (!android) {
    emit(
      err,
      `${"obsidian-e2e.config.mjs"} has no "android" block. Add at least ` +
        `{ android: { avd: "<your-avd-name>" } } to use the android runner.`,
    );
    return 1;
  }

  const options = resolveAndroidOptions(parsed, config, cwd);
  const ensureDeps: AndroidEnsureDependencies = deps.ensureDeps ?? {
    adb: { execFile: execFileAdb },
  };
  const machine = options.printEnv || options.json;
  const humanWrite = machine ? err : out;
  ensureDeps.log ??= (message) => emit(humanWrite, message);

  switch (subcommand) {
    case "start": {
      const ensure = deps.ensureAndroidInstance ?? realEnsureAndroidInstance;
      const result = await ensure(options, config, android, ensureDeps);
      emit(
        humanWrite,
        `Android instance ${result.reusedEmulator ? "reused" : "launched"} on ${result.serial} ` +
          `(vault "${result.vaultName}", CDP port ${result.cdpPort}).`,
      );
      if (options.json) {
        emit(out, JSON.stringify(result, null, 2));
      } else if (options.printEnv) {
        emit(out, androidShellExports(result, config));
      }
      return 0;
    }
    case "stop": {
      const stop = deps.stopAndroidInstance ?? realStopAndroidInstance;
      const result = await stop(android, ensureDeps);
      emit(
        options.json ? err : out,
        result.stopped
          ? `Stopped the Android emulator ${result.serial}.`
          : `No emulator running AVD "${android.avd}".`,
      );
      if (options.json) emit(out, JSON.stringify(result, null, 2));
      return 0;
    }
    case "run": {
      const ensure = deps.ensureAndroidInstance ?? realEnsureAndroidInstance;
      const result = await ensure(options, config, android, ensureDeps);
      const command = parsed.rest.length > 0 ? parsed.rest : config.defaultCommand;
      const code = parseEvalCommand(command);
      if (code === null) {
        emit(
          err,
          `android run only supports "eval code=<javascript>" (there is no obsidian CLI on ` +
            `Android). Got: ${command.join(" ")}`,
        );
        return 1;
      }
      const connect = deps.connectCdp ?? CdpClient.connect.bind(CdpClient);
      const client = await connect(result.cdpPort, ensureDeps.cdp ?? {});
      try {
        const evaluated = await client.evaluate(code);
        if (evaluated.exception) {
          if (options.json) emit(out, JSON.stringify({ exception: evaluated.exception }));
          emit(err, `Evaluation failed: ${evaluated.exception}`);
          return 1;
        }
        const value = evaluated.value;
        if (options.json) {
          // Wrapped so an `undefined` result still yields a parseable document.
          emit(out, JSON.stringify({ value: value ?? null }));
        } else {
          emit(out, `=> ${typeof value === "string" ? value : JSON.stringify(value)}`);
        }
        return 0;
      } finally {
        client.close();
      }
    }
  }
}

/**
 * Accept the desktop CLI's eval spelling (`eval code=<js>`) so the same
 * `defaultCommand` works against both runners when it is an eval.
 */
export function parseEvalCommand(command: readonly string[]): string | null {
  if (command[0] !== "eval") return null;
  const codeArg = command.slice(1).find((token) => token.startsWith("code="));
  return codeArg ? codeArg.slice("code=".length) : null;
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function androidHelp(): string {
  return [
    "obsidian-e2e android <start|stop|run> [flags] [-- eval code=<js>]",
    "",
    "Run the plugin inside the real Obsidian Android app on an emulator. Requires",
    'an "android" block in obsidian-e2e.config.mjs naming an existing AVD (created',
    "once per machine with avdmanager; use a google_apis image - it must be adb-",
    "rootable). The app is driven over its webview devtools socket (CDP).",
    "",
    "Commands:",
    "  start   Boot (or reuse) the AVD, install the app if needed, select and",
    "          provision the vault, push the plugin artifacts, enable the plugin.",
    "  stop    Force-stop the app and shut the emulator down.",
    "  run     Bring the instance up, then evaluate `eval code=<js>` over CDP.",
    "",
    "Flags:",
    "  --vault <name>      vault name (default: <vaultPrefix>-<worktree basename>)",
    "  --worktree <dir>    worktree whose artifacts are pushed (default: current directory)",
    "  --data <file>       data.json seed pushed verbatim on first provision",
    "  --config <file>     path to obsidian-e2e.config.mjs",
    "  --json              emit a JSON document on stdout; human output goes to stderr",
    "  --print-env         emit `export OBSIDIAN_E2E_ANDROID_*` lines on stdout for eval",
    "  --help              show this help",
  ].join("\n");
}
