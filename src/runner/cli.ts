import { spawn as realSpawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { commandErrorMessage } from "../core/errors";
import {
  parseArgs,
  SHARED_BOOLEAN_OPTIONS,
  SHARED_VALUE_OPTIONS,
  type ArgsParserSpec,
  type ParsedArgs,
} from "./args";
import { loadRunnerConfig as realLoadRunnerConfig } from "./config";
import { ensureObsidianInstance as realEnsureObsidianInstance } from "./ensure";
import { INSTANCE_MARKER_FILE, resolveInstanceOptions, toInstanceShellExports } from "./instance";
import type { ObsidianExecDependencies } from "./launch";
import {
  provisionShellExports,
  provisionVault as realProvisionVault,
  resolveProvisionOptions,
} from "./provision";
import { runAndroidCli, type AndroidCliDependencies } from "./android/cli";
import { assertSecureDirIfPresent, ensureSecureDir } from "./security";
import {
  reapOrphanedInstances as realReapOrphanedInstances,
  stopInstance as realStopInstance,
} from "./stop";
import type {
  InstanceOptions,
  InstanceRawOptions,
  ProvisionRawOptions,
  ResolvedRunnerConfig,
} from "./types";

/** A minimal view of the child process `spawnObsidian` needs, so a fake can stand in. */
export interface ChildProcessLike {
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
) => ChildProcessLike;

/** All boundaries the CLI touches, injected so `runObsidianE2ECli` is testable end to end. */
export interface CliDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  loadRunnerConfig?: typeof realLoadRunnerConfig;
  ensureObsidianInstance?: typeof realEnsureObsidianInstance;
  provisionVault?: typeof realProvisionVault;
  stopInstance?: typeof realStopInstance;
  reapOrphanedInstances?: typeof realReapOrphanedInstances;
  spawn?: SpawnFn;
  /** Re-raise a signal to ourselves so the exit status mirrors the child's. */
  killSelf?: (signal: NodeJS.Signals) => void;
  /** Threaded into the launcher calls so tests never spawn a real Obsidian. */
  exec?: ObsidianExecDependencies;
  /** Threaded into the android family so tests never touch adb or a device. */
  android?: AndroidCliDependencies;
}

const SUBCOMMANDS = ["provision", "start", "stop", "run", "android"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const PROVISION_SPEC: ArgsParserSpec = {
  valueOptions: SHARED_VALUE_OPTIONS,
  booleanOptions: { ...SHARED_BOOLEAN_OPTIONS, "--print-env": "printEnv" },
};

const START_SPEC: ArgsParserSpec = {
  valueOptions: SHARED_VALUE_OPTIONS,
  booleanOptions: {
    ...SHARED_BOOLEAN_OPTIONS,
    "--print-env": "printEnv",
    "--no-launch": "noLaunch",
    "--skip-version-guard": "skipVersionGuard",
  },
};

const STOP_SPEC: ArgsParserSpec = {
  valueOptions: SHARED_VALUE_OPTIONS,
  booleanOptions: { ...SHARED_BOOLEAN_OPTIONS, "--dry-run": "dryRun", "--prune": "prune" },
};

const RUN_SPEC: ArgsParserSpec = {
  valueOptions: SHARED_VALUE_OPTIONS,
  booleanOptions: { ...SHARED_BOOLEAN_OPTIONS, "--skip-version-guard": "skipVersionGuard" },
};

/** Isolated HOME environment for the forwarded `obsidian` command. */
export function obsidianEnv(
  options: { obsidianHome: string },
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env, HOME: options.obsidianHome };
}

/** Prefix the forwarded command with the `vault=<name>` selector the CLI expects. */
export function obsidianCommandArgs(vaultName: string, command: readonly string[]): string[] {
  return [`vault=${vaultName}`, ...command];
}

/**
 * Run the real `obsidian` CLI against the isolated instance with stdio inherited,
 * resolving the process exit code. When the child is killed by a signal we re-raise
 * that same signal to ourselves so our exit status mirrors it (Ctrl-C stays Ctrl-C);
 * otherwise the resolved code is `code ?? 1` so a null exit never reads as success.
 */
export function spawnObsidian(
  options: InstanceOptions,
  command: readonly string[],
  deps: CliDependencies = {},
): Promise<number> {
  const spawn = deps.spawn ?? (realSpawn as unknown as SpawnFn);
  const killSelf = deps.killSelf ?? ((signal: NodeJS.Signals) => process.kill(process.pid, signal));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text));

  return new Promise((resolve) => {
    const child = spawn(options.obsidianBin, obsidianCommandArgs(options.vaultName, command), {
      stdio: "inherit",
      env: obsidianEnv(options, deps.env),
    });
    child.on("error", (error) => {
      stderr(`Failed to run obsidian: ${commandErrorMessage(error)}\n`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        killSelf(signal);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * The bin entry: route `provision|start|stop|run`, load the worktree config, and
 * run the subcommand. Returns the process exit code. Expected failures (missing
 * config, insecure profile root, a mid-session version change) throw and are
 * surfaced by {@link main} as exit 1 with a clean message.
 */
export async function runObsidianE2ECli(
  argv: readonly string[],
  deps: CliDependencies = {},
): Promise<number> {
  const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const err = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const emitLine = (write: (text: string) => void, line: string) => write(`${line}\n`);

  const [maybeSubcommand, ...rest] = argv;

  if (maybeSubcommand === undefined || maybeSubcommand === "--help" || maybeSubcommand === "-h") {
    emitLine(out, topLevelHelp());
    return 0;
  }
  if (!isSubcommand(maybeSubcommand)) {
    emitLine(err, `Unknown command: ${maybeSubcommand}`);
    emitLine(err, topLevelHelp());
    return 1;
  }

  // The android family owns its own sub-subcommand, flag spec, and config load
  // (its `--config`/`--worktree` appear after the sub-subcommand token).
  if (maybeSubcommand === "android") {
    return runAndroidCli(rest, {
      cwd: deps.cwd,
      stdout: deps.stdout,
      stderr: deps.stderr,
      loadRunnerConfig: deps.loadRunnerConfig,
      ...deps.android,
    });
  }

  const spec = specFor(maybeSubcommand);
  const parsed = parseArgs([...rest], spec);
  if (parsed.options.help === true) {
    emitLine(out, subcommandHelp(maybeSubcommand));
    return 0;
  }

  const cwd = deps.cwd ?? process.cwd();
  const worktreePath = path.resolve(cwd, asString(parsed.options.worktree) ?? ".");
  const loadRunnerConfig = deps.loadRunnerConfig ?? realLoadRunnerConfig;
  const config = await loadRunnerConfig(worktreePath, asString(parsed.options.config));

  switch (maybeSubcommand) {
    case "provision":
      return runProvision(parsed, config, cwd, deps, out, err);
    case "start":
      return runStart(parsed, config, cwd, deps, out, err);
    case "stop":
      return runStop(parsed, config, cwd, deps, out, err);
    case "run":
      return runRun(parsed, config, cwd, deps, out, err);
  }
}

async function runProvision(
  parsed: ParsedArgs,
  config: ResolvedRunnerConfig,
  cwd: string,
  deps: CliDependencies,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const provisionVault = deps.provisionVault ?? realProvisionVault;
  const options = resolveProvisionOptions(toProvisionRaw(parsed.options), config, cwd);
  const result = await provisionVault(options, config);

  const machine = options.printEnv || options.json;
  const humanWrite = machine ? err : out;
  emit(humanWrite, `Provisioned vault "${result.vaultName}" at ${result.vaultPath}`);

  if (options.json) {
    emit(out, JSON.stringify(result, null, 2));
  } else if (options.printEnv) {
    emit(out, provisionShellExports(result, config));
  }
  return 0;
}

async function runStart(
  parsed: ParsedArgs,
  config: ResolvedRunnerConfig,
  cwd: string,
  deps: CliDependencies,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const options = resolveInstanceOptions(
    resolveProvisionOptions(toProvisionRaw(parsed.options), config, cwd),
    toInstanceRaw(parsed.options),
    config,
    cwd,
  );

  const machine = options.printEnv || options.json;
  const result = await bringUpInstance(options, config, deps, machine ? err : out);

  const state = !result.launched ? "prepared" : result.reused ? "reused" : "launched";
  emit(
    machine ? err : out,
    `Obsidian instance ${state} for "${options.vaultName}" (HOME ${options.obsidianHome}).`,
  );

  if (options.json) {
    emit(
      out,
      JSON.stringify(
        {
          vaultName: options.vaultName,
          vaultPath: options.vaultPath,
          obsidianHome: options.obsidianHome,
          obsidianBin: options.obsidianBin,
          launched: result.launched,
          reused: result.reused,
          appVersion: result.appVersion,
          minAppVersion: result.minAppVersion,
        },
        null,
        2,
      ),
    );
  } else if (options.printEnv) {
    emit(out, provisionShellExports(result.provision, config));
    emit(
      out,
      toInstanceShellExports({
        obsidianHome: options.obsidianHome,
        obsidianBin: options.obsidianBin,
        envPrefix: config.envPrefix,
      }),
    );
  }
  return 0;
}

async function runStop(
  parsed: ParsedArgs,
  config: ResolvedRunnerConfig,
  cwd: string,
  deps: CliDependencies,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const stopInstance = deps.stopInstance ?? realStopInstance;
  const reapOrphanedInstances = deps.reapOrphanedInstances ?? realReapOrphanedInstances;
  const options = resolveInstanceOptions(
    resolveProvisionOptions(toProvisionRaw(parsed.options), config, cwd),
    toInstanceRaw(parsed.options),
    config,
    cwd,
  );
  const dryRun = parsed.options.dryRun === true;
  const prune = parsed.options.prune === true;
  const machine = options.json;
  const humanWrite = machine ? err : out;

  // Fail closed before touching the tree: refuse to kill/remove through a
  // hijacked or symlinked profile root. stopInstance itself does not re-check.
  await assertSecureDirIfPresent(options.profileRoot);

  const stopResult = await stopInstance(options.instancePath, {
    dryRun,
    profileRoot: options.profileRoot,
  });
  emit(
    humanWrite,
    dryRun
      ? `Would stop instance ${stopResult.instancePath} (pids: ${stopResult.pids.join(", ") || "none"}).`
      : `Stopped instance ${stopResult.instancePath}: terminated ${stopResult.terminated.length}, ` +
          `killed ${stopResult.killed.length}${stopResult.removed ? ", removed" : ""}.`,
  );

  let reaped: string[] = [];
  if (prune) {
    const reapResult = await reapOrphanedInstances({
      profileRoot: options.profileRoot,
      markerFile: INSTANCE_MARKER_FILE,
      exceptInstancePath: options.instancePath,
      dryRun,
      log: (message) => emit(err, message),
    });
    reaped = reapResult.reaped;
    emit(
      humanWrite,
      `Pruned ${reapResult.reaped.length} orphaned instance(s) of ${reapResult.scanned} scanned.`,
    );
  }

  if (options.json) {
    emit(out, JSON.stringify({ ...stopResult, reaped }, null, 2));
  }
  return 0;
}

async function runRun(
  parsed: ParsedArgs,
  config: ResolvedRunnerConfig,
  cwd: string,
  deps: CliDependencies,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const options = resolveInstanceOptions(
    resolveProvisionOptions(toProvisionRaw(parsed.options), config, cwd),
    toInstanceRaw(parsed.options),
    config,
    cwd,
  );
  // Everything after the first non-option token (or a bare `--`) is the forwarded
  // command; an empty forward falls back to the config's default command.
  const command = parsed.rest.length > 0 ? parsed.rest : config.defaultCommand;

  const machine = options.json;
  await bringUpInstance(options, config, deps, machine ? err : out);

  return spawnObsidian(options, command, deps);
}

/**
 * The shared bring-up used by `start` and `run`: secure the profile root, reap
 * orphaned instances (worktree-gone), then ensure this instance is verified and
 * live. Reaping never touches the current instance (`exceptInstancePath`), so it
 * is a safe self-healing step on every bring-up.
 */
async function bringUpInstance(
  options: InstanceOptions,
  config: ResolvedRunnerConfig,
  deps: CliDependencies,
  humanWrite: (text: string) => void,
) {
  const ensure = deps.ensureObsidianInstance ?? realEnsureObsidianInstance;
  const reapOrphanedInstances = deps.reapOrphanedInstances ?? realReapOrphanedInstances;

  await ensureSecureDir(options.profileRoot);
  await reapOrphanedInstances({
    profileRoot: options.profileRoot,
    markerFile: INSTANCE_MARKER_FILE,
    exceptInstancePath: options.instancePath,
    log: (message) => emit(humanWrite, message),
  });

  return ensure(options, config, {
    exec: deps.exec,
    log: (message) => emit(humanWrite, message),
  });
}

function emit(write: (text: string) => void, line: string): void {
  write(`${line}\n`);
}

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function specFor(subcommand: Exclude<Subcommand, "android">): ArgsParserSpec {
  switch (subcommand) {
    case "provision":
      return PROVISION_SPEC;
    case "start":
      return START_SPEC;
    case "stop":
      return STOP_SPEC;
    case "run":
      return RUN_SPEC;
  }
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toProvisionRaw(options: Record<string, string | boolean>): ProvisionRawOptions {
  return {
    config: asString(options.config),
    data: asString(options.data),
    force: options.force === true,
    json: options.json === true,
    printEnv: options.printEnv === true,
    root: asString(options.root),
    vault: asString(options.vault),
    worktree: asString(options.worktree),
  };
}

function toInstanceRaw(options: Record<string, string | boolean>): InstanceRawOptions {
  return {
    ...toProvisionRaw(options),
    launch: options.noLaunch === true ? false : undefined,
    obsidianApp: asString(options.obsidianApp),
    obsidianBin: asString(options.obsidianBin),
    profileRoot: asString(options.profileRoot),
    skipVersionGuard: options.skipVersionGuard === true,
  };
}

const SHARED_FLAGS = [
  "  --vault <name>          vault name (default: <vaultPrefix>-<worktree basename>)",
  "  --root <dir>            vault root directory (default: <worktree>/.obsidian-e2e-vaults)",
  "  --worktree <dir>        worktree to isolate (default: current directory)",
  "  --data <file>           data.json seed copied verbatim on first provision",
  "  --profile-root <dir>    private profile root (default: /tmp/<pluginId>-obsidian-e2e)",
  "  --obsidian-app <name>   Obsidian .app name (default: Obsidian)",
  "  --obsidian-bin <path>   obsidian CLI binary (default: obsidian)",
  "  --config <file>         path to obsidian-e2e.config.mjs (default: <worktree>/obsidian-e2e.config.mjs)",
  "  --force                 relink plugin artifacts even if a conflicting entry exists",
  "  --json                  emit a JSON document on stdout; all human output goes to stderr",
  "  --help                  show this help",
].join("\n");

function topLevelHelp(): string {
  return [
    "obsidian-e2e <provision|start|stop|run> [flags] [-- <obsidian command>]",
    "",
    "Worktree-isolated Obsidian instance runner. Reads obsidian-e2e.config.mjs at the",
    "worktree root. Each worktree gets its own vault, private HOME, and app instance,",
    "so parallel checkouts never collide and never touch other plugins' instances.",
    "",
    "Commands:",
    "  provision   Lay down the worktree-local vault (pure filesystem, no launch).",
    "  start       Provision, prepare the profile, and bring the instance up and verified.",
    "  stop        Terminate this worktree's instance and remove its profile.",
    "  run         Bring the instance up, then forward a command to the obsidian CLI.",
    "  android     Drive the real Obsidian Android app on an emulator (start|stop|run).",
    "",
    "Run `obsidian-e2e <command> --help` for per-command flags.",
  ].join("\n");
}

function subcommandHelp(subcommand: Exclude<Subcommand, "android">): string {
  switch (subcommand) {
    case "provision":
      return [
        "obsidian-e2e provision [flags]",
        "",
        "Provision the worktree-local vault: write the .obsidian config, symlink the",
        "plugin's build artifacts, and seed data.json. Pure filesystem - it never",
        "launches Obsidian.",
        "",
        "Flags:",
        SHARED_FLAGS,
        "  --print-env             emit `export OBSIDIAN_E2E_*` lines on stdout for eval",
      ].join("\n");
    case "start":
      return [
        "obsidian-e2e start [flags]",
        "",
        "Provision, prepare the private profile, guard the Obsidian app version, then",
        "reuse-and-reload a warm instance or launch a fresh one and verify the plugin.",
        "",
        "Flags:",
        SHARED_FLAGS,
        "  --print-env             emit `export OBSIDIAN_E2E_*` lines on stdout for eval",
        "  --no-launch             prepare the profile only; do not launch or verify",
        "  --skip-version-guard    skip the minAppVersion / mid-session update guard",
      ].join("\n");
    case "stop":
      return [
        "obsidian-e2e stop [flags]",
        "",
        "Terminate this worktree's Obsidian instance (SIGTERM, then SIGKILL for",
        "stragglers) and remove its private profile. Safe to run when nothing is up.",
        "",
        "Flags:",
        SHARED_FLAGS,
        "  --dry-run               report the process tree and would-remove path; change nothing",
        "  --prune                 also reap every orphaned instance whose backing worktree is gone",
      ].join("\n");
    case "run":
      return [
        "obsidian-e2e run [flags] [-- <obsidian command>]",
        "",
        "Bring the instance up (reaping instances whose backing worktree is gone), then",
        "forward the command after the first non-option token (or after `--`) to the",
        "obsidian CLI against this vault. With no command, the config's default runs.",
        "",
        "Flags:",
        SHARED_FLAGS,
        "  --skip-version-guard    skip the minAppVersion / mid-session update guard",
      ].join("\n");
  }
}
