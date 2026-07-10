import { describe, expect, test } from "vite-plus/test";

import { resolveRunnerConfig } from "../../src/runner/config";
import { ensureObsidianInstance, type EnsureDependencies } from "../../src/runner/ensure";
import type { InstanceMarker, InstanceOptions, ResolvedRunnerConfig } from "../../src/runner/types";

const CONFIG: ResolvedRunnerConfig = resolveRunnerConfig({ pluginId: "quickadd" });

function makeOptions(overrides: Partial<InstanceOptions> = {}): InstanceOptions {
  const worktreePath = "/work/tree";
  const vaultName = "quickadd-tree";
  const vaultPath = "/work/tree/.obsidian-e2e-vaults/quickadd-tree";
  const instancePath = "/tmp/quickadd-obsidian-e2e/quickadd-tree-abc123def456";
  const obsidianHome = `${instancePath}/home`;
  return {
    dataPath: undefined,
    force: false,
    json: false,
    printEnv: false,
    rootPath: "/work/tree/.obsidian-e2e-vaults",
    vaultName,
    vaultPath,
    worktreePath,
    instanceId: "quickadd-tree-abc123def456",
    instancePath,
    launch: true,
    obsidianApp: "Obsidian",
    obsidianBin: "obsidian",
    obsidianHome,
    profileRoot: "/tmp/quickadd-obsidian-e2e",
    skipVersionGuard: false,
    userDataPath: `${obsidianHome}/Library/Application Support/obsidian`,
    ...overrides,
  };
}

interface Recorder {
  calls: string[];
  reloadArgs: unknown[][];
  stampArgs: unknown[][];
  logs: string[];
}

/**
 * Build a fully-faked dependency set that records the call order and the branch
 * each orchestration step took. `marker` seeds the previous instance marker read
 * BEFORE prepare; `ready` selects the reuse-reload vs launch-fresh branch;
 * `guardVersion` is what the version guard resolves (distinct from the prepare-time
 * prediction so the stamp-uses-guard-version assertion is meaningful).
 */
function makeDeps(config: {
  marker: InstanceMarker | null;
  ready: boolean;
  guardVersion?: string | null;
  prepareVersion?: string | null;
}): { deps: EnsureDependencies; rec: Recorder } {
  const rec: Recorder = { calls: [], reloadArgs: [], stampArgs: [], logs: [] };
  const guardVersion = config.guardVersion === undefined ? "1.13.0" : config.guardVersion;
  const prepareVersion = config.prepareVersion === undefined ? "1.12.7" : config.prepareVersion;

  const deps: EnsureDependencies = {
    readInstanceMarker: async () => {
      rec.calls.push("readInstanceMarker");
      return config.marker;
    },
    provisionVault: async (options) => {
      rec.calls.push("provisionVault");
      return {
        pluginPath: `${options.vaultPath}/.obsidian/plugins/quickadd`,
        vaultName: options.vaultName,
        vaultPath: options.vaultPath,
        worktreePath: options.worktreePath,
      };
    },
    prepareObsidianProfile: async (options) => {
      rec.calls.push("prepareObsidianProfile");
      return {
        obsidianJsonPath: `${options.userDataPath}/obsidian.json`,
        userDataPath: `${options.instancePath}/home/prepared/obsidian`,
        vaultId: "vault0123456789ab",
        appVersion: prepareVersion,
      };
    },
    assertObsidianMeetsMinAppVersion: async () => {
      rec.calls.push("assertObsidianMeetsMinAppVersion");
      return { appVersion: guardVersion as string, installerVersion: null, minAppVersion: "1.0.0" };
    },
    isInstanceReady: async () => {
      rec.calls.push("isInstanceReady");
      return config.ready;
    },
    launchObsidianInstance: async () => {
      rec.calls.push("launchObsidianInstance");
    },
    waitForInstanceReady: async () => {
      rec.calls.push("waitForInstanceReady");
      return "/resolved/vault";
    },
    reloadPlugin: async (target, pluginId) => {
      rec.calls.push("reloadPlugin");
      rec.reloadArgs.push([target, pluginId]);
    },
    trustVaultAndVerifyPlugin: async () => {
      rec.calls.push("trustVaultAndVerifyPlugin");
      return true;
    },
    stampInstanceMarkerAppVersion: async (instancePath, appVersion) => {
      rec.calls.push("stampInstanceMarkerAppVersion");
      rec.stampArgs.push([instancePath, appVersion]);
    },
    log: (message) => rec.logs.push(message),
  };
  return { deps, rec };
}

describe("ensureObsidianInstance", () => {
  test("launch-fresh branch: launch + wait + stamp, no reload, then verify", async () => {
    const options = makeOptions();
    const { deps, rec } = makeDeps({ marker: null, ready: false });

    const result = await ensureObsidianInstance(options, CONFIG, deps);

    expect(rec.calls).toEqual([
      "readInstanceMarker",
      "provisionVault",
      "prepareObsidianProfile",
      "assertObsidianMeetsMinAppVersion",
      "isInstanceReady",
      "launchObsidianInstance",
      "waitForInstanceReady",
      "stampInstanceMarkerAppVersion",
      "trustVaultAndVerifyPlugin",
    ]);
    expect(rec.calls).not.toContain("reloadPlugin");
    expect(result.launched).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.appVersion).toBe("1.13.0");
    expect(result.minAppVersion).toBe("1.0.0");
  });

  test("reuse-reload branch: reload BEFORE verify, no launch", async () => {
    const options = makeOptions();
    // A warm instance whose recorded version matches the resolved guard version.
    const { deps, rec } = makeDeps({
      marker: {
        appVersion: "1.13.0",
        vaultName: options.vaultName,
        vaultPath: options.vaultPath,
        worktreePath: options.worktreePath,
      },
      ready: true,
    });

    const result = await ensureObsidianInstance(options, CONFIG, deps);

    expect(rec.calls).toEqual([
      "readInstanceMarker",
      "provisionVault",
      "prepareObsidianProfile",
      "assertObsidianMeetsMinAppVersion",
      "isInstanceReady",
      "reloadPlugin",
      "trustVaultAndVerifyPlugin",
    ]);
    // Reload strictly precedes verify so a rebuilt main.js takes effect.
    expect(rec.calls.indexOf("reloadPlugin")).toBeLessThan(
      rec.calls.indexOf("trustVaultAndVerifyPlugin"),
    );
    expect(rec.reloadArgs[0]?.[1]).toBe("quickadd");
    expect(result.reused).toBe(true);
    expect(rec.calls).not.toContain("launchObsidianInstance");
  });

  test("version-mismatch on reuse throws with the stop hint and skips verify", async () => {
    const options = makeOptions();
    const { deps, rec } = makeDeps({
      marker: {
        appVersion: "1.12.0",
        vaultName: options.vaultName,
        vaultPath: options.vaultPath,
        worktreePath: options.worktreePath,
      },
      ready: true,
      guardVersion: "1.13.0",
    });

    await expect(ensureObsidianInstance(options, CONFIG, deps)).rejects.toThrow(
      /stop:e2e-obsidian/,
    );
    expect(rec.calls).not.toContain("trustVaultAndVerifyPlugin");
    expect(rec.calls).not.toContain("reloadPlugin");
  });

  test("unmarked reuse warns but proceeds to reload + verify", async () => {
    const options = makeOptions();
    const { deps, rec } = makeDeps({
      marker: {
        appVersion: null,
        vaultName: options.vaultName,
        vaultPath: options.vaultPath,
        worktreePath: options.worktreePath,
      },
      ready: true,
    });

    const result = await ensureObsidianInstance(options, CONFIG, deps);

    expect(rec.logs.some((line) => /no recorded app version/.test(line))).toBe(true);
    expect(rec.calls).toContain("reloadPlugin");
    expect(result.reused).toBe(true);
  });

  test("reads the previous marker BEFORE prepare rewrites it", async () => {
    const options = makeOptions();
    const { deps, rec } = makeDeps({ marker: null, ready: false });

    await ensureObsidianInstance(options, CONFIG, deps);

    expect(rec.calls.indexOf("readInstanceMarker")).toBeLessThan(
      rec.calls.indexOf("prepareObsidianProfile"),
    );
  });

  test("sets options.userDataPath once from the profile prep result", async () => {
    const options = makeOptions();
    const { deps } = makeDeps({ marker: null, ready: false });

    await ensureObsidianInstance(options, CONFIG, deps);

    expect(options.userDataPath).toBe(`${options.instancePath}/home/prepared/obsidian`);
  });

  test("stamps the marker with the GUARD-resolved version, not the prepare prediction", async () => {
    const options = makeOptions();
    const { deps, rec } = makeDeps({
      marker: null,
      ready: false,
      guardVersion: "1.13.0",
      prepareVersion: "1.12.7",
    });

    await ensureObsidianInstance(options, CONFIG, deps);

    expect(rec.stampArgs[0]).toEqual([options.instancePath, "1.13.0"]);
  });

  test("--no-launch prepares only: no guard, no ready check, no launch", async () => {
    const options = makeOptions({ launch: false });
    const { deps, rec } = makeDeps({ marker: null, ready: false, prepareVersion: "1.12.7" });

    const result = await ensureObsidianInstance(options, CONFIG, deps);

    expect(rec.calls).toEqual(["readInstanceMarker", "provisionVault", "prepareObsidianProfile"]);
    expect(result.launched).toBe(false);
    expect(result.appVersion).toBe("1.12.7");
  });

  test("skipVersionGuard bypasses the guard and its reuse comparison", async () => {
    const options = makeOptions({ skipVersionGuard: true });
    // A recorded version that would otherwise mismatch: with the guard skipped the
    // reuse path must not throw.
    const { deps, rec } = makeDeps({
      marker: {
        appVersion: "0.0.1",
        vaultName: options.vaultName,
        vaultPath: options.vaultPath,
        worktreePath: options.worktreePath,
      },
      ready: true,
    });

    const result = await ensureObsidianInstance(options, CONFIG, deps);

    expect(rec.calls).not.toContain("assertObsidianMeetsMinAppVersion");
    expect(result.reused).toBe(true);
    expect(result.minAppVersion).toBeNull();
  });
});
