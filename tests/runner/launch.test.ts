import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";
import type {
  ExecFileFn,
  ExecFileResult,
  ExecFileRunOptions,
  InstanceReadyTarget,
  LaunchTarget,
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
});

describe("launchObsidianInstance", () => {
  test("opens Obsidian backgrounded with the isolated HOME and user-data-dir", async () => {
    const profileRoot = await createTempDir(tempDirectories, "profile-root-");
    const instancePath = path.join(profileRoot, "instance");
    const target: LaunchTarget = {
      obsidianApp: "Obsidian",
      obsidianHome: path.join(instancePath, "home"),
      userDataPath: path.join(instancePath, "home", "data"),
      profileRoot,
      instancePath,
    };
    const { execFile, calls } = makeExec(() => ok(""));

    await launchObsidianInstance(target, { execFile });

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
