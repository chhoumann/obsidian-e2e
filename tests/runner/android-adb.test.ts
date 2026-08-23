import { describe, expect, test } from "vite-plus/test";

import {
  type AdbDependencies,
  ensureAdbRoot,
  ensureEmulator,
  findEmulatorSerial,
  startApp,
} from "../../src/runner/android/adb";
import type { ResolvedAndroidConfig } from "../../src/runner/types";

const android: ResolvedAndroidConfig = {
  avd: "qa-e2e",
  adbBin: "adb",
  emulatorBin: "emulator",
  cdpPort: 9222,
  bootTimeoutMs: 10_000,
};

/**
 * A scripted exec fake: each call is matched by joining the argv, and the
 * calls are recorded so ordering assertions read naturally.
 */
function fakeExec(script: Record<string, string | (() => string)>) {
  const calls: string[] = [];
  const execFile: AdbDependencies["execFile"] = (file, args) => {
    const key = [file, ...args].join(" ");
    calls.push(key);
    for (const [pattern, output] of Object.entries(script)) {
      if (key.includes(pattern)) {
        const value = typeof output === "function" ? output() : output;
        if (value.startsWith("THROW:")) return Promise.reject(new Error(value.slice(6)));
        return Promise.resolve({ stdout: value, stderr: "" });
      }
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  };
  return { calls, execFile };
}

/** Instant timing so timeout paths run without real waiting. */
function instantTiming() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
  };
}

describe("findEmulatorSerial", () => {
  test("matches the emulator whose reported AVD name equals the configured one", async () => {
    const { execFile } = fakeExec({
      "adb devices": "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n",
      "-s emulator-5554 emu avd name": "other-avd\nOK",
      "-s emulator-5556 emu avd name": "qa-e2e\nOK",
    });
    expect(await findEmulatorSerial(android, { execFile })).toBe("emulator-5556");
  });

  test("ignores offline devices and non-emulator serials", async () => {
    const { execFile } = fakeExec({
      "adb devices": "List of devices attached\nemulator-5554\toffline\nR58M12ABC\tdevice\n",
    });
    expect(await findEmulatorSerial(android, { execFile })).toBeNull();
  });

  test("explains a missing adb binary", async () => {
    const execFile = () => Promise.reject(new Error("ENOENT"));
    await expect(findEmulatorSerial(android, { execFile })).rejects.toThrow(
      /Install Android platform-tools/,
    );
  });
});

describe("ensureEmulator", () => {
  test("reuses a running emulator without spawning", async () => {
    const { execFile } = fakeExec({
      "adb devices": "List of devices attached\nemulator-5554\tdevice\n",
      "emu avd name": "qa-e2e\nOK",
    });
    let spawned = 0;
    const serial = await ensureEmulator(android, "/tmp/log", {
      execFile,
      spawnDetached: () => {
        spawned += 1;
        return Promise.resolve();
      },
      ...instantTiming(),
    });
    expect(serial).toBe("emulator-5554");
    expect(spawned).toBe(0);
  });

  test("boots headless and polls until sys.boot_completed", async () => {
    let devicesCalls = 0;
    const { execFile } = fakeExec({
      "adb devices": () =>
        (devicesCalls += 1) < 3
          ? "List of devices attached\n"
          : "List of devices attached\nemulator-5554\tdevice\n",
      "emu avd name": "qa-e2e\nOK",
      "getprop sys.boot_completed": "1",
    });
    const spawns: string[] = [];
    const serial = await ensureEmulator(android, "/tmp/log", {
      execFile,
      spawnDetached: (file, args, logPath) => {
        spawns.push([file, ...args, logPath].join(" "));
        return Promise.resolve();
      },
      ...instantTiming(),
    });
    expect(serial).toBe("emulator-5554");
    expect(spawns).toEqual([
      "emulator -avd qa-e2e -no-window -no-audio -no-boot-anim -no-snapshot /tmp/log/emulator.log",
    ]);
  });

  test("times out with a pointer at the emulator log", async () => {
    const { execFile } = fakeExec({ "adb devices": "List of devices attached\n" });
    await expect(
      ensureEmulator(android, "/tmp/log", {
        execFile,
        spawnDetached: () => Promise.resolve(),
        ...instantTiming(),
      }),
    ).rejects.toThrow(/did not boot within 10000ms.*emulator\.log/s);
  });
});

describe("ensureAdbRoot", () => {
  test("rejects a Play-Store image with a clear error", async () => {
    const { execFile } = fakeExec({
      "-s emulator-5554 root": "adbd cannot run as root in production builds",
    });
    await expect(
      ensureAdbRoot({ adbBin: "adb", serial: "emulator-5554" }, { execFile, ...instantTiming() }),
    ).rejects.toThrow(/google_apis .*not rootable/s);
  });

  test("waits for the device after the adbd restart", async () => {
    const { calls, execFile } = fakeExec({ root: "restarting adbd as root" });
    await ensureAdbRoot(
      { adbBin: "adb", serial: "emulator-5554" },
      { execFile, ...instantTiming() },
    );
    expect(calls.at(-1)).toContain("wait-for-device");
  });
});

describe("startApp", () => {
  test("returns the pid once the webview devtools socket is up", async () => {
    const { execFile } = fakeExec({
      "am start": "Starting: Intent",
      "pidof md.obsidian": "4321",
      "cat /proc/net/unix": "@webview_devtools_remote_4321",
    });
    const pid = await startApp(
      { adbBin: "adb", serial: "emulator-5554" },
      { execFile, ...instantTiming() },
    );
    expect(pid).toBe("4321");
  });

  test("times out when the socket never appears", async () => {
    const { execFile } = fakeExec({
      "am start": "Starting: Intent",
      "pidof md.obsidian": "4321",
      "cat /proc/net/unix": "nothing here",
    });
    await expect(
      startApp({ adbBin: "adb", serial: "emulator-5554" }, { execFile, ...instantTiming() }),
    ).rejects.toThrow(/devtools socket/);
  });
});
