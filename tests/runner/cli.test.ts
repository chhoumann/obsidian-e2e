import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { resolveRunnerConfig } from "../../src/runner/config";
import type { EnsureResult } from "../../src/runner/ensure";
import {
  type ChildProcessLike,
  type CliDependencies,
  type SpawnFn,
  obsidianCommandArgs,
  obsidianEnv,
  runObsidianE2ECli,
  spawnObsidian,
} from "../../src/runner/cli";
import { slugify } from "../../src/runner/fs-utils";
import { stableInstanceId } from "../../src/runner/instance";
import type { InstanceOptions, ResolvedRunnerConfig } from "../../src/runner/types";
import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

interface Streams {
  out: string[];
  err: string[];
}

function makeStreams(): {
  streams: Streams;
  stdout: (t: string) => void;
  stderr: (t: string) => void;
} {
  const streams: Streams = { out: [], err: [] };
  return {
    streams,
    stdout: (text) => streams.out.push(text),
    stderr: (text) => streams.err.push(text),
  };
}

const stubEnsure = async (
  options: InstanceOptions,
  config: ResolvedRunnerConfig,
): Promise<EnsureResult> => ({
  provision: {
    pluginPath: `${options.vaultPath}/.obsidian/plugins/${config.pluginId}`,
    vaultName: options.vaultName,
    vaultPath: options.vaultPath,
    worktreePath: options.worktreePath,
  },
  launched: true,
  reused: false,
  appVersion: "1.13.0",
  minAppVersion: "1.0.0",
});

/** A fake spawn whose child fires `close` with the configured `(code, signal)`. */
function makeSpawn(
  close: { code: number | null; signal: NodeJS.Signals | null },
  record?: (file: string, args: string[]) => void,
): SpawnFn {
  return (file, args) => {
    record?.(file, [...args]);
    const child: ChildProcessLike = {
      on(event: string, listener: (...cbArgs: never[]) => void) {
        if (event === "close") {
          (listener as (code: number | null, signal: NodeJS.Signals | null) => void)(
            close.code,
            close.signal,
          );
        }
        return child;
      },
    } as ChildProcessLike;
    return child;
  };
}

/** Config loader that ignores the path and returns a resolved config for `raw`. */
function configLoader(raw: Record<string, unknown>): CliDependencies["loadRunnerConfig"] {
  return async () => resolveRunnerConfig(raw);
}

describe("runObsidianE2ECli routing", () => {
  test("no arguments prints top-level help to stdout and returns 0", async () => {
    const { streams, stdout, stderr } = makeStreams();
    const code = await runObsidianE2ECli([], { stdout, stderr });
    expect(code).toBe(0);
    expect(streams.out.join("")).toContain("obsidian-e2e <provision|start|stop|run>");
    expect(streams.err.join("")).toBe("");
  });

  test("an unknown command reports to stderr and returns 1", async () => {
    const { streams, stdout, stderr } = makeStreams();
    const code = await runObsidianE2ECli(["frobnicate"], { stdout, stderr });
    expect(code).toBe(1);
    expect(streams.err.join("")).toContain("Unknown command: frobnicate");
  });

  test("a subcommand --help prints that command's help and never loads config", async () => {
    const { streams, stdout, stderr } = makeStreams();
    let loaded = false;
    const code = await runObsidianE2ECli(["stop", "--help"], {
      stdout,
      stderr,
      loadRunnerConfig: async () => {
        loaded = true;
        return resolveRunnerConfig({ pluginId: "quickadd" });
      },
    });
    expect(code).toBe(0);
    expect(loaded).toBe(false);
    expect(streams.out.join("")).toContain("obsidian-e2e stop");
    expect(streams.out.join("")).toContain("backing worktree is gone");
  });

  test("--config is forwarded to the config loader", async () => {
    const seen: string[] = [];
    const worktree = await createTempDir(tempDirectories, "cli-config-");
    await runObsidianE2ECli(["run", "--config", "/custom/obsidian-e2e.config.mjs"], {
      cwd: worktree,
      stdout: () => {},
      stderr: () => {},
      loadRunnerConfig: async (_worktreePath, configPath) => {
        seen.push(configPath ?? "<none>");
        return resolveRunnerConfig({ pluginId: "quickadd" });
      },
      ensureObsidianInstance: stubEnsure,
      reapOrphanedInstances: async () => ({ scanned: 0, reaped: [] }),
      spawn: makeSpawn({ code: 0, signal: null }),
    });
    expect(seen).toEqual(["/custom/obsidian-e2e.config.mjs"]);
  });
});

describe("run command forwarding", () => {
  async function runForward(argv: string[], defaultCommand: string[]): Promise<string[]> {
    const worktree = await createTempDir(tempDirectories, "cli-run-");
    const profileRoot = await createTempDir(tempDirectories, "cli-profile-");
    let captured: string[] = [];
    await runObsidianE2ECli(
      ["run", "--worktree", worktree, "--profile-root", profileRoot, ...argv],
      {
        cwd: worktree,
        stdout: () => {},
        stderr: () => {},
        loadRunnerConfig: configLoader({ pluginId: "quickadd", defaultCommand }),
        ensureObsidianInstance: stubEnsure,
        reapOrphanedInstances: async () => ({ scanned: 0, reaped: [] }),
        spawn: makeSpawn({ code: 0, signal: null }, (_file, args) => {
          // Drop the leading `vault=<name>` selector; keep the forwarded command.
          captured = args.slice(1);
        }),
      },
    );
    return captured;
  }

  test("forwards tokens after the first non-option token", async () => {
    expect(await runForward(["eval", "code=1"], ["default:cmd"])).toEqual(["eval", "code=1"]);
  });

  test("forwards option-like args after a bare -- terminator", async () => {
    expect(await runForward(["--", "--version"], ["default:cmd"])).toEqual(["--version"]);
  });

  test("falls back to the config default command when none is forwarded", async () => {
    expect(await runForward([], ["eval", "code=app.vault.getName()"])).toEqual([
      "eval",
      "code=app.vault.getName()",
    ]);
  });

  test("accepts --skip-version-guard and threads it into the bring-up", async () => {
    const worktree = await createTempDir(tempDirectories, "cli-run-guard-");
    const profileRoot = await createTempDir(tempDirectories, "cli-profile-");
    let seen: InstanceOptions | undefined;
    const code = await runObsidianE2ECli(
      ["run", "--worktree", worktree, "--profile-root", profileRoot, "--skip-version-guard"],
      {
        cwd: worktree,
        stdout: () => {},
        stderr: () => {},
        loadRunnerConfig: configLoader({
          pluginId: "quickadd",
          defaultCommand: ["eval", "code=1"],
        }),
        ensureObsidianInstance: async (options, config) => {
          seen = options;
          return stubEnsure(options, config);
        },
        reapOrphanedInstances: async () => ({ scanned: 0, reaped: [] }),
        spawn: makeSpawn({ code: 0, signal: null }),
      },
    );
    expect(code).toBe(0);
    expect(seen?.skipVersionGuard).toBe(true);
  });
});

describe("run against a warm instance", () => {
  async function runWarm(
    argv: string[],
    evalReplies: string[] = [],
    plant?: (profileRoot: string, worktree: string) => Promise<void>,
  ) {
    const worktree = await createTempDir(tempDirectories, "cli-run-warm-");
    const profileRoot = await createTempDir(tempDirectories, "cli-profile-");
    await plant?.(profileRoot, worktree);
    const cliCalls: string[][] = [];
    let ensured = 0;
    let guarded = 0;
    let forwarded: string[] = [];
    const code = await runObsidianE2ECli(
      ["run", "--worktree", worktree, "--profile-root", profileRoot, ...argv],
      {
        cwd: worktree,
        stdout: () => {},
        stderr: () => {},
        loadRunnerConfig: configLoader({ pluginId: "quickadd" }),
        ensureObsidianInstance: async (options, config) => {
          ensured += 1;
          return stubEnsure(options, config);
        },
        guardWarmInstance: async () => {
          guarded += 1;
        },
        reapOrphanedInstances: async () => ({ scanned: 0, reaped: [] }),
        // The live socket answers `vault info=path` with this worktree's vault.
        exec: {
          socketExists: async () => true,
          sleep: async () => {},
          execFile: async (_file, args) => {
            cliCalls.push([...args]);
            if (args[1] === "eval") return { stdout: evalReplies.shift() ?? "", stderr: "" };
            const vaultArg = args[0] ?? "";
            const vaultName = vaultArg.slice("vault=".length);
            return { stdout: path.join(worktree, ".obsidian-e2e-vaults", vaultName), stderr: "" };
          },
        },
        spawn: makeSpawn({ code: 0, signal: null }, (_file, args) => {
          forwarded = args.slice(1);
        }),
      },
    );
    return { code, cliCalls, ensured, guarded, forwarded };
  }

  test("checks the vault identity and forwards without reloading or re-verifying", async () => {
    const result = await runWarm(["eval", "code=1"]);
    expect(result.code).toBe(0);
    expect(result.ensured).toBe(0);
    expect(result.guarded).toBe(1);
    expect(result.cliCalls.map((args) => args.slice(1))).toEqual([["vault", "info=path"]]);
    expect(result.forwarded).toEqual(["eval", "code=1"]);
  });

  test("refuses to attach through a symlinked instance directory", async () => {
    const plantSymlink = async (profileRoot: string, worktree: string) => {
      const vaultName = `quickadd-${slugify(path.basename(worktree))}`;
      const instanceId = stableInstanceId(worktree, vaultName);
      const elsewhere = await createTempDir(tempDirectories, "cli-planted-");
      await fs.symlink(elsewhere, path.join(profileRoot, instanceId));
    };
    await expect(runWarm(["eval", "code=1"], [], plantSymlink)).rejects.toThrow();
  });

  test("dev:mobile holds the exit until the reloaded renderer reports the new mode", async () => {
    const result = await runWarm(
      ["dev:mobile", "on"],
      ['Error: Command "eval" not found.', "=> false", "=> true"],
    );
    expect(result.code).toBe(0);
    expect(result.forwarded).toEqual(["dev:mobile", "on"]);
    const probes = result.cliCalls.filter((args) => args[1] === "eval");
    expect(probes).toHaveLength(3);
    expect(probes[0]?.[2]).toBe("code=app.isMobile === true && app.workspace.layoutReady");
  });

  test("--reload redeploys through the full bring-up first", async () => {
    const result = await runWarm(["--reload", "eval", "code=1"]);
    expect(result.ensured).toBe(1);
    expect(result.guarded).toBe(0);
    expect(result.forwarded).toEqual(["eval", "code=1"]);
  });
});

describe("spawnObsidian", () => {
  const options = {
    obsidianBin: "obsidian",
    obsidianHome: "/tmp/home",
    vaultName: "v",
  } as InstanceOptions;

  test("prefixes vault= and runs against the isolated HOME", () => {
    let call: { file: string; args: string[] } | undefined;
    void spawnObsidian(options, ["eval", "code=1"], {
      spawn: makeSpawn({ code: 0, signal: null }, (file, args) => {
        call = { file, args };
      }),
      env: { PATH: "/bin" },
    });
    expect(call?.file).toBe("obsidian");
    expect(call?.args).toEqual(["vault=v", "eval", "code=1"]);
    expect(obsidianEnv(options, { PATH: "/bin" }).HOME).toBe("/tmp/home");
    expect(obsidianCommandArgs("v", ["x"])).toEqual(["vault=v", "x"]);
  });

  test("re-raises the child's terminating signal to itself", async () => {
    const raised: NodeJS.Signals[] = [];
    const code = await spawnObsidian(options, ["eval"], {
      spawn: makeSpawn({ code: null, signal: "SIGINT" }),
      killSelf: (signal) => raised.push(signal),
    });
    expect(raised).toEqual(["SIGINT"]);
    expect(code).toBe(1);
  });

  test("resolves code ?? 1 so a null exit is never treated as success", async () => {
    const nullExit = await spawnObsidian(options, ["eval"], {
      spawn: makeSpawn({ code: null, signal: null }),
    });
    expect(nullExit).toBe(1);
    const explicit = await spawnObsidian(options, ["eval"], {
      spawn: makeSpawn({ code: 2, signal: null }),
    });
    expect(explicit).toBe(2);
  });
});

describe("provision --print-env stdout hygiene", () => {
  async function makeWorktree(): Promise<string> {
    const worktree = await createTempDir(tempDirectories, "cli-provision-");
    await fs.writeFile(path.join(worktree, "manifest.json"), JSON.stringify({ id: "quickadd" }));
    await fs.writeFile(path.join(worktree, "main.js"), "module.exports = {};");
    return worktree;
  }

  test("emits ONLY export lines on stdout; the human summary goes to stderr", async () => {
    const worktree = await makeWorktree();
    const { streams, stdout, stderr } = makeStreams();

    const code = await runObsidianE2ECli(["provision", "--worktree", worktree, "--print-env"], {
      cwd: worktree,
      stdout,
      stderr,
      loadRunnerConfig: configLoader({ pluginId: "quickadd" }),
    });

    expect(code).toBe(0);
    const stdoutLines = streams.out
      .join("")
      .split("\n")
      .filter((line) => line.length > 0);
    // Every stdout line is a shell export; the summary never pollutes stdout.
    for (const line of stdoutLines) {
      expect(line.startsWith("export ")).toBe(true);
    }
    expect(stdoutLines.some((line) => line.startsWith("export OBSIDIAN_E2E_VAULT="))).toBe(true);
    expect(streams.err.join("")).toContain("Provisioned vault");
  });

  test("emits legacy <PREFIX>_E2E_* aliases when envPrefix is configured", async () => {
    const worktree = await makeWorktree();
    const { streams, stdout, stderr } = makeStreams();

    await runObsidianE2ECli(["provision", "--worktree", worktree, "--print-env"], {
      cwd: worktree,
      stdout,
      stderr,
      loadRunnerConfig: configLoader({ pluginId: "quickadd", envPrefix: "QUICKADD" }),
    });

    const stdout_ = streams.out.join("");
    expect(stdout_).toContain("export OBSIDIAN_E2E_VAULT=");
    expect(stdout_).toContain("export QUICKADD_E2E_VAULT=");
    expect(stdout_).toContain("export QUICKADD_E2E_VAULT_PATH=");
  });
});
