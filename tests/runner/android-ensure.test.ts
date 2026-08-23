import { describe, expect, test } from "vite-plus/test";

import type { AdbDependencies } from "../../src/runner/android/adb";
import type { CdpSocket } from "../../src/runner/android/cdp";
import {
  type AndroidEnsureDependencies,
  type AndroidOptions,
  DEVICE_VAULT_ROOT,
  ensureAndroidInstance,
  stopAndroidInstance,
} from "../../src/runner/android/ensure";
import { resolveRunnerConfig } from "../../src/runner/config";
import type { ResolvedAndroidConfig } from "../../src/runner/types";

const android: ResolvedAndroidConfig = {
  avd: "qa-e2e",
  apk: "/apks/Obsidian.apk",
  adbBin: "adb",
  emulatorBin: "emulator",
  cdpPort: 9222,
  bootTimeoutMs: 10_000,
};

const options: AndroidOptions = {
  vaultName: "quickadd-main",
  worktreePath: "/worktree",
  dataPath: undefined,
  json: false,
  printEnv: false,
};

interface HarnessState {
  installed: boolean;
  currentVault: string | null;
  dataJsonOnDevice: boolean;
}

/**
 * A whole-device fake: scripts the adb boundary and a CDP endpoint whose
 * answers depend on mutable device state, so the orchestration's branches
 * (fresh vs warm, seeded vs unseeded) are drivable per test.
 */
function harness(state: HarnessState) {
  const adbCalls: string[] = [];
  const evaluated: string[] = [];

  const execFile: AdbDependencies["execFile"] = (file, args) => {
    const key = [file, ...args].join(" ");
    adbCalls.push(key);
    const reply = (stdout: string) => Promise.resolve({ stdout, stderr: "" });
    if (key.includes("adb devices"))
      return reply("List of devices attached\nemulator-5554\tdevice\n");
    if (key.includes("emu avd name")) return reply("qa-e2e\nOK");
    if (key.includes("getprop sys.boot_completed")) return reply("1");
    if (key.includes("pm path md.obsidian"))
      return reply(state.installed ? "package:/data/app/base.apk" : "");
    if (key.includes("install -r")) {
      state.installed = true;
      return reply("Success");
    }
    if (key.includes(" root")) return reply("restarting adbd as root");
    if (key.includes("pidof md.obsidian")) return reply("4321");
    if (key.includes("cat /proc/net/unix")) return reply("@webview_devtools_remote_4321");
    if (key.includes("stat -c %u")) return reply("10192");
    if (key.includes("test -f")) return reply(state.dataJsonOnDevice ? "yes" : "no");
    return reply("");
  };

  const socket = (): CdpSocket => {
    let listener: (data: string) => void = () => {};
    return {
      send: (data) => {
        const message = JSON.parse(data) as { id: number; params: { expression: string } };
        const expression = message.params.expression;
        evaluated.push(expression);
        let value: unknown = true;
        if (expression.includes("app.vault.getName()") && !expression.includes("localStorage")) {
          value = state.currentVault;
        }
        if (expression.includes("localStorage.setItem")) {
          state.currentVault = "quickadd-main";
        }
        queueMicrotask(() =>
          listener(JSON.stringify({ id: message.id, result: { result: { value } } })),
        );
      },
      close: () => {},
      onMessage: (l) => {
        listener = l;
      },
    };
  };

  const deps: AndroidEnsureDependencies = {
    adb: {
      execFile,
      spawnDetached: () => Promise.resolve(),
      now: () => 0,
      sleep: () => Promise.resolve(),
    },
    cdp: {
      fetchJson: () => Promise.resolve([{ type: "page", webSocketDebuggerUrl: "ws://fake" }]),
      connect: () => Promise.resolve(socket()),
    },
    assertArtifacts: () => Promise.resolve(),
    dataSeedExists: () => Promise.resolve(true),
  };
  return { adbCalls, evaluated, deps };
}

const config = resolveRunnerConfig({ pluginId: "quickadd", pluginArtifacts: ["main.js"] });

describe("ensureAndroidInstance", () => {
  test("fresh device: installs, selects the vault, pushes, seeds, enables, probes", async () => {
    const state: HarnessState = { installed: false, currentVault: null, dataJsonOnDevice: false };
    const { adbCalls, evaluated, deps } = harness(state);

    const result = await ensureAndroidInstance(options, config, android, deps);

    expect(result.serial).toBe("emulator-5554");
    expect(result.vaultPath).toBe(`${DEVICE_VAULT_ROOT}/quickadd-main`);
    expect(state.installed).toBe(true);
    // Rooting restarts adbd and drops forwards, so it must precede the forward.
    const rootIndex = adbCalls.findIndex((c) => c.endsWith(" root"));
    const forwardIndex = adbCalls.findIndex((c) => c.includes("forward tcp:9222"));
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    expect(forwardIndex).toBeGreaterThan(rootIndex);
    // The vault got selected over localStorage and the plugin enabled.
    expect(evaluated.some((e) => e.includes("localStorage.setItem"))).toBe(true);
    expect(evaluated.some((e) => e.includes("setEnable"))).toBe(true);
    // Artifacts pushed; the data.json seed written because none existed.
    expect(adbCalls.some((c) => c.includes("push /worktree/main.js"))).toBe(true);
    expect(adbCalls.some((c) => c.includes("data.json"))).toBe(true);
  });

  test("warm device with the right vault open: no reinstall, no vault switch, no reseed", async () => {
    const state: HarnessState = {
      installed: true,
      currentVault: "quickadd-main",
      dataJsonOnDevice: true,
    };
    const { adbCalls, evaluated, deps } = harness(state);

    const result = await ensureAndroidInstance(options, config, android, deps);

    expect(result.reusedEmulator).toBe(true);
    expect(adbCalls.some((c) => c.includes("install -r"))).toBe(false);
    expect(evaluated.some((e) => e.includes("localStorage.setItem"))).toBe(false);
    // Artifacts still track the current build even on a warm instance.
    expect(adbCalls.some((c) => c.includes("push /worktree/main.js"))).toBe(true);
    // The existing device data.json is preserved (no push/write of a new one).
    expect(adbCalls.some((c) => c.includes("printf"))).toBe(false);
  });

  test("uninstalled app without a configured apk fails with the download hint", async () => {
    const state: HarnessState = { installed: false, currentVault: null, dataJsonOnDevice: false };
    const { deps } = harness(state);

    await expect(
      ensureAndroidInstance(options, config, { ...android, apk: undefined }, deps),
    ).rejects.toThrow(/obsidianmd\/obsidian-releases/);
  });

  test("a command-kind readyProbe falls back to the plugin-loaded check with a note", async () => {
    const state: HarnessState = {
      installed: true,
      currentVault: "quickadd-main",
      dataJsonOnDevice: true,
    };
    const { evaluated, deps } = harness(state);
    const logs: string[] = [];
    deps.log = (message) => logs.push(message);

    const commandProbeConfig = resolveRunnerConfig({
      pluginId: "quickadd",
      pluginArtifacts: ["main.js"],
      readyProbe: { kind: "command", args: ["quickadd:list"], match: '"ok":true' },
    });
    await ensureAndroidInstance(options, commandProbeConfig, android, deps);

    expect(logs.some((l) => l.includes("cannot run on Android"))).toBe(true);
    expect(evaluated.some((e) => e.includes('app.plugins.plugins["quickadd"]'))).toBe(true);
  });
});

describe("stopAndroidInstance", () => {
  test("stops the app and the emulator when one is running", async () => {
    const state: HarnessState = { installed: true, currentVault: null, dataJsonOnDevice: false };
    const { adbCalls, deps } = harness(state);

    const result = await stopAndroidInstance(android, deps);

    expect(result).toEqual({ stopped: true, serial: "emulator-5554" });
    expect(adbCalls.some((c) => c.includes("am force-stop md.obsidian"))).toBe(true);
    expect(adbCalls.some((c) => c.includes("emu kill"))).toBe(true);
  });

  test("is a no-op when nothing runs the AVD", async () => {
    const deps: AndroidEnsureDependencies = {
      adb: {
        execFile: () => Promise.resolve({ stdout: "List of devices attached\n", stderr: "" }),
      },
    };
    expect(await stopAndroidInstance(android, deps)).toEqual({ stopped: false, serial: null });
  });
});
