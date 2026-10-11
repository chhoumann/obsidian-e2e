import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { linuxCliSocket } from "../helpers/cli-socket";
import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";
import { installXvfbStandIns } from "../helpers/fake-xvfb-run";
import type {
  ExecFileFn,
  ExecFileResult,
  ExecFileRunOptions,
  InstanceReadyTarget,
  LaunchTarget,
  SpawnDetachedFn,
  VaultExecTarget,
} from "../../src/runner/launch";
import {
  cliSocketExists,
  cliSocketPath,
  execObsidian,
  isInstanceReady,
  launchObsidianInstance,
  reloadPlugin,
  trustVaultAndVerifyPlugin,
  waitForInstanceReady,
} from "../../src/runner/launch";
import type { ReadyProbe } from "../../src/runner/types";

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTempDirectories(tempDirectories);
});

interface ExecCall {
  file: string;
  args: string[];
  options: ExecFileRunOptions | undefined;
}

/** A recording fake `execFile`; the handler produces the result per call. */
function makeExec(handler: (call: ExecCall) => ExecFileResult | Promise<ExecFileResult>): {
  execFile: ExecFileFn;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const execFile: ExecFileFn = async (file, args, options) => {
    const call: ExecCall = { file, args: [...args], options };
    calls.push(call);
    return handler(call);
  };
  return { execFile, calls };
}

const ok = (stdout: string): ExecFileResult => ({ stdout, stderr: "" });

const vaultTarget: InstanceReadyTarget = {
  obsidianBin: "obsidian",
  obsidianHome: "/tmp/profile/home",
  vaultName: "quickadd-worktree-a",
  vaultPath: "/tmp/vaults/quickadd-worktree-a",
};

describe("execObsidian", () => {
  test("runs the CLI binary against the isolated HOME", async () => {
    const { execFile, calls } = makeExec(() => ok("hi"));
    const result = await execObsidian(vaultTarget, ["vault=v", "eval", "code=1"], { execFile });

    expect(result.stdout).toBe("hi");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("obsidian");
    expect(calls[0]?.args).toEqual(["vault=v", "eval", "code=1"]);
    expect(calls[0]?.options?.env?.HOME).toBe("/tmp/profile/home");
  });

  test("on Linux the CLI reaches the private socket even with XDG_RUNTIME_DIR set", async () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
    const { execFile, calls } = makeExec(() => ok(""));

    await execObsidian(vaultTarget, ["vault=v", "eval", "code=1"], {
      execFile,
      platform: "linux",
    });

    expect(linuxCliSocket(calls[0]?.options?.env)).toBe(cliSocketPath(vaultTarget));
  });
});

async function makeLaunchTarget(obsidianApp: string): Promise<LaunchTarget> {
  const profileRoot = await createTempDir(tempDirectories, "profile-root-");
  const instancePath = path.join(profileRoot, "instance");
  return {
    obsidianApp,
    obsidianHome: path.join(instancePath, "home"),
    userDataPath: path.join(instancePath, "home", "Library", "Application Support", "obsidian"),
    profileRoot,
    instancePath,
  };
}

describe("launchObsidianInstance", () => {
  test("opens Obsidian backgrounded with the isolated HOME and user-data-dir", async () => {
    const target = await makeLaunchTarget("Obsidian");
    const { execFile, calls } = makeExec(() => ok(""));

    await launchObsidianInstance(target, { execFile, platform: "darwin" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/open");
    expect(calls[0]?.args).toEqual([
      "-n",
      "-g",
      "-a",
      "Obsidian",
      "--env",
      `HOME=${target.obsidianHome}`,
      "--args",
      `--user-data-dir=${target.userDataPath}`,
      "--password-store=basic",
    ]);
    expect(calls[0]?.options?.env?.HOME).toBe(target.obsidianHome);
  });

  test("on Linux without a display, spawns the executable detached under xvfb-run", async () => {
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
    vi.stubEnv("XDG_CONFIG_HOME", "/home/user/.config");
    const app = path.join(await createTempDir(tempDirectories, "obsidian-install-"), "obsidian");
    await fs.writeFile(app, "", { mode: 0o755 });
    const target = await makeLaunchTarget(app);
    const { execFile, calls } = makeExec(() => ok(""));
    const spawned: {
      file: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
      cwd?: string;
    }[] = [];
    const logPaths: string[] = [];
    const spawnDetached: SpawnDetachedFn = async (file, args, { env, cwd, logPath }) => {
      spawned.push({ file, args, env, cwd });
      logPaths.push(logPath);
    };

    await launchObsidianInstance(target, { execFile, spawnDetached, platform: "linux" });

    expect(calls).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.file).toBe("xvfb-run");
    expect(spawned[0]?.cwd).toBe(target.instancePath);
    expect(spawned[0]?.args).toEqual([
      "-a",
      "-f",
      "Xauthority",
      "-s",
      "-screen 0 3840x3200x24",
      "/bin/sh",
      "-c",
      expect.any(String),
      "sh",
      path.join(target.instancePath, "Xauthority"),
      process.cwd(),
      app,
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${target.userDataPath}`,
      "--password-store=basic",
    ]);
    expect(spawned[0]?.env.HOME).toBe(target.obsidianHome);
    expect(spawned[0]?.env.WAYLAND_DISPLAY).toBeUndefined();
    expect(linuxCliSocket(spawned[0]?.env)).toBe(cliSocketPath(target));
    const { XDG_CONFIG_HOME, HOME } = spawned[0]?.env ?? {};
    expect(path.join(XDG_CONFIG_HOME || path.join(HOME ?? "", ".config"), "obsidian")).toBe(
      target.userDataPath,
    );
    expect(process.env.XDG_CONFIG_HOME).toBe("/home/user/.config");
    expect(logPaths).toEqual([path.join(target.instancePath, "obsidian.log")]);
  });

  test("on Linux under xvfb-run a profile root with spaces starts the app from the caller's cwd", async () => {
    const dir = await createTempDir(tempDirectories, "xvfb-run-");
    const { app, readLaunch } = await installXvfbStandIns(dir);
    vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("DISPLAY", "");
    const profileRoot = path.join(dir, "profile root");
    const instancePath = path.join(profileRoot, "instance");
    const target: LaunchTarget = {
      obsidianApp: path.relative(process.cwd(), app),
      obsidianHome: path.join(instancePath, "home"),
      userDataPath: path.join(instancePath, "home", ".config", "obsidian"),
      profileRoot,
      instancePath,
    };

    await launchObsidianInstance(target, { platform: "linux" });

    const launch = await vi.waitFor(readLaunch, { timeout: 5_000 });
    expect(launch.cwd).toBe(await fs.realpath(process.cwd()));
    expect(launch.xauthority).toBe(path.join(instancePath, "Xauthority"));
    await expect(fs.access(launch.xauthority)).resolves.toBeUndefined();
    expect(launch.args).toContain(`--user-data-dir=${target.userDataPath}`);
  });

  test("on Linux an appName that is not an executable file fails before spawning", async () => {
    const dir = await createTempDir(tempDirectories, "obsidian-install-");
    const plainFile = path.join(dir, "obsidian");
    await fs.writeFile(plainFile, "", { mode: 0o644 });
    let spawned = 0;
    const spawnDetached: SpawnDetachedFn = async () => {
      spawned += 1;
    };

    for (const app of [path.join(dir, "missing"), dir, plainFile]) {
      const target = await makeLaunchTarget(app);
      await expect(
        launchObsidianInstance(target, { spawnDetached, platform: "linux" }),
      ).rejects.toThrow(`"${app}" is not an executable file`);
    }
    expect(spawned).toBe(0);
  });

  test("on Linux a CLI socket path over 107 bytes fails before spawning", async () => {
    const app = path.join(await createTempDir(tempDirectories, "obsidian-install-"), "obsidian");
    await fs.writeFile(app, "", { mode: 0o755 });
    const spawned: string[] = [];
    const spawnDetached: SpawnDetachedFn = async (file) => {
      spawned.push(file);
    };
    const launchWithHome = async (obsidianHome: string) =>
      launchObsidianInstance(
        { ...(await makeLaunchTarget(app)), obsidianHome },
        { spawnDetached, platform: "linux" },
      );
    const maxHomeBytes = 107 - Buffer.byteLength("/.obsidian-cli.sock");
    const multibyteHome = `/é${"a".repeat(maxHomeBytes - 2)}`;
    expect(cliSocketPath({ obsidianHome: multibyteHome })).toHaveLength(107);

    await launchWithHome(`/${"a".repeat(maxHomeBytes - 1)}`);
    expect(spawned).toHaveLength(1);
    const tooLong = /is 108 bytes, but Linux allows at most 107\. Shorten profileRoot/;
    await expect(launchWithHome(`/${"a".repeat(maxHomeBytes)}`)).rejects.toThrow(tooLong);
    await expect(launchWithHome(multibyteHome)).rejects.toThrow(tooLong);
    expect(spawned).toHaveLength(1);
  });
});

describe("cliSocketExists", () => {
  test("delegates to the injected socket probe on the .obsidian-cli.sock path", async () => {
    const seen: string[] = [];
    const present = await cliSocketExists(vaultTarget, {
      socketExists: async (socketPath) => {
        seen.push(socketPath);
        return true;
      },
    });
    expect(present).toBe(true);
    expect(seen).toEqual([cliSocketPath(vaultTarget)]);
    expect(cliSocketPath(vaultTarget)).toBe("/tmp/profile/home/.obsidian-cli.sock");
  });
});

describe("isInstanceReady", () => {
  test("returns false WITHOUT probing when the socket is absent (double-launch guard)", async () => {
    const { execFile, calls } = makeExec(() => {
      throw new Error("must not probe a cold HOME");
    });

    const ready = await isInstanceReady(vaultTarget, {
      execFile,
      socketExists: async () => false,
    });

    expect(ready).toBe(false);
    // The regression this pins: a cold probe would auto-launch a competing instance.
    expect(calls).toHaveLength(0);
  });

  test("probes and matches the resolved vault path when the socket exists", async () => {
    const { execFile, calls } = makeExec(() => ok(`${vaultTarget.vaultPath}\n`));

    const ready = await isInstanceReady(vaultTarget, {
      execFile,
      socketExists: async () => true,
    });

    expect(ready).toBe(true);
    expect(calls[0]?.args).toEqual([`vault=${vaultTarget.vaultName}`, "vault", "info=path"]);
  });

  test("returns false when the running instance serves a different vault", async () => {
    const { execFile } = makeExec(() => ok("/tmp/other-vault\n"));
    const ready = await isInstanceReady(vaultTarget, { execFile, socketExists: async () => true });
    expect(ready).toBe(false);
  });
});

describe("waitForInstanceReady", () => {
  test("waits for the socket before probing, then returns the resolved path", async () => {
    let clock = 0;
    let socketReady = false;
    const { execFile, calls } = makeExec(() => ok(`${vaultTarget.vaultPath}\n`));

    const resolved = await waitForInstanceReady(vaultTarget, {
      execFile,
      socketExists: async () => socketReady,
      now: () => clock,
      // The first wait advances the clock and brings the socket up.
      sleep: async (ms) => {
        clock += ms;
        socketReady = true;
      },
      timeoutMs: 5_000,
      intervalMs: 500,
    });

    expect(resolved).toBe(path.resolve(vaultTarget.vaultPath));
    // No probe was issued during the socket-absent iteration.
    expect(calls).toHaveLength(1);
  });

  test("throws after the deadline when readiness never resolves", async () => {
    let clock = 0;
    const { execFile } = makeExec(() => ok("/tmp/other-vault\n"));

    await expect(
      waitForInstanceReady(vaultTarget, {
        execFile,
        socketExists: async () => true,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        timeoutMs: 1_000,
        intervalMs: 500,
      }),
    ).rejects.toThrow(/did not become ready/);
  });
});

describe("reloadPlugin", () => {
  test("issues plugin:reload with the plugin id", async () => {
    const target: VaultExecTarget = {
      obsidianBin: "obsidian",
      obsidianHome: "/tmp/home",
      vaultName: "quickadd-worktree-a",
    };
    const { execFile, calls } = makeExec(() => ok(""));

    await reloadPlugin(target, "quickadd", { execFile });

    expect(calls[0]?.args).toEqual(["vault=quickadd-worktree-a", "plugin:reload", "id=quickadd"]);
  });
});

describe("trustVaultAndVerifyPlugin", () => {
  const target: VaultExecTarget = {
    obsidianBin: "obsidian",
    obsidianHome: "/tmp/home",
    vaultName: "quickadd-worktree-a",
  };
  const fast = { now: () => 0, sleep: async () => {}, timeoutMs: 5_000, intervalMs: 100 };

  test("disables Restricted Mode then confirms an eval probe (=> true)", async () => {
    const evalProbe: ReadyProbe = {
      kind: "eval",
      code: 'Boolean(app.plugins.plugins["quickadd"])',
      match: "=> true",
    };
    const { execFile, calls } = makeExec((call) =>
      call.args.includes("plugins:restrict") ? ok("") : ok("Boolean(...) => true"),
    );

    await expect(trustVaultAndVerifyPlugin(target, evalProbe, { execFile, ...fast })).resolves.toBe(
      true,
    );
    expect(calls[0]?.args).toEqual(["vault=quickadd-worktree-a", "plugins:restrict", "off"]);
    expect(calls[1]?.args).toEqual([
      "vault=quickadd-worktree-a",
      "eval",
      'code=Boolean(app.plugins.plugins["quickadd"])',
    ]);
  });

  test("confirms a command probe against its own match string", async () => {
    const commandProbe: ReadyProbe = {
      kind: "command",
      args: ["quickadd:list"],
      match: '"ok":true',
    };
    const { execFile, calls } = makeExec((call) =>
      call.args.includes("plugins:restrict") ? ok("") : ok('{"ok":true}'),
    );

    await expect(
      trustVaultAndVerifyPlugin(target, commandProbe, { execFile, ...fast }),
    ).resolves.toBe(true);
    expect(calls[1]?.args).toEqual(["vault=quickadd-worktree-a", "quickadd:list"]);
  });

  test("waits for a renderer created after a reloading Restricted Mode toggle", async () => {
    const probe: ReadyProbe = { kind: "command", args: ["quickadd:list"], match: '"ok":true' };
    // The last reply echoes the expression, as some CLI builds do.
    const reloadReplies = ['Error: Command "eval" not found.', "=> false", "cond => true"];
    const { execFile, calls } = makeExec((call) => {
      if (call.args.includes("plugins:restrict")) {
        return ok("Restricted mode disabled. Reloading...");
      }
      if (call.args[1] === "eval") return ok(reloadReplies.shift() ?? "");
      return ok('{"ok":true}');
    });

    await expect(trustVaultAndVerifyPlugin(target, probe, { execFile, ...fast })).resolves.toBe(
      true,
    );
    const steps = calls.map((call) => call.args[1]);
    expect(steps).toEqual(["plugins:restrict", "eval", "eval", "eval", "quickadd:list"]);
    expect(calls[1]?.args[2]).toMatch(
      /^code=performance\.timeOrigin > \d+ && app\.workspace\.layoutReady$/,
    );
  });

  test("throws after the deadline when the probe never matches", async () => {
    let clock = 0;
    const probe: ReadyProbe = { kind: "eval", code: "x", match: "=> true" };
    const { execFile } = makeExec((call) =>
      call.args.includes("plugins:restrict") ? ok("") : ok("=> false"),
    );

    await expect(
      trustVaultAndVerifyPlugin(target, probe, {
        execFile,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        timeoutMs: 1_000,
        intervalMs: 500,
      }),
    ).rejects.toThrow(/did not become available/);
  });
});
