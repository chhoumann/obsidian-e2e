import { describe, expect, test } from "vite-plus/test";

import type { AndroidEnsureResult } from "../../src/runner/android/ensure";
import { parseEvalCommand, runAndroidCli } from "../../src/runner/android/cli";
import { runObsidianE2ECli } from "../../src/runner/cli";
import { resolveRunnerConfig } from "../../src/runner/config";

function makeStreams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
}

const androidConfig = resolveRunnerConfig({
  pluginId: "quickadd",
  envPrefix: "QUICKADD",
  android: { avd: "qa-e2e" },
});

const ensureResult: AndroidEnsureResult = {
  serial: "emulator-5554",
  cdpPort: 9222,
  vaultName: "quickadd-main",
  vaultPath: "/storage/emulated/0/Android/data/md.obsidian/files/quickadd-main",
  reusedEmulator: false,
};

describe("runAndroidCli", () => {
  test("prints help with no subcommand and fails on an unknown one", async () => {
    const streams = makeStreams();
    expect(await runAndroidCli([], { stdout: streams.stdout, stderr: streams.stderr })).toBe(0);
    expect(streams.out.join("")).toContain("android <start|stop|run>");

    const bad = makeStreams();
    expect(await runAndroidCli(["frobnicate"], { stdout: bad.stdout, stderr: bad.stderr })).toBe(1);
    expect(bad.err.join("")).toContain("Unknown android command: frobnicate");
  });

  test("refuses to run without an android config block", async () => {
    const streams = makeStreams();
    const code = await runAndroidCli(["start"], {
      stdout: streams.stdout,
      stderr: streams.stderr,
      loadRunnerConfig: () => Promise.resolve(resolveRunnerConfig({ pluginId: "quickadd" })),
    });
    expect(code).toBe(1);
    expect(streams.err.join("")).toContain('no "android" block');
  });

  test("start --print-env emits the canonical and prefixed exports on stdout", async () => {
    const streams = makeStreams();
    const code = await runAndroidCli(["start", "--print-env"], {
      cwd: "/repo/main",
      stdout: streams.stdout,
      stderr: streams.stderr,
      loadRunnerConfig: () => Promise.resolve(androidConfig),
      ensureAndroidInstance: () => Promise.resolve(ensureResult),
      ensureDeps: { adb: { execFile: () => Promise.reject(new Error("unused")) } },
    });
    expect(code).toBe(0);
    const stdout = streams.out.join("");
    expect(stdout).toContain("export OBSIDIAN_E2E_ANDROID_SERIAL='emulator-5554'");
    expect(stdout).toContain("export OBSIDIAN_E2E_ANDROID_CDP_PORT='9222'");
    expect(stdout).toContain("export QUICKADD_E2E_ANDROID_VAULT='quickadd-main'");
    // Human progress goes to stderr so the stdout eval stays clean.
    expect(streams.err.join("")).toContain("Android instance launched on emulator-5554");
  });

  test("run evaluates an eval command over CDP and prints `=> value`", async () => {
    const streams = makeStreams();
    const code = await runAndroidCli(["run", "--", "eval", "code=app.vault.getName()"], {
      stdout: streams.stdout,
      stderr: streams.stderr,
      loadRunnerConfig: () => Promise.resolve(androidConfig),
      ensureAndroidInstance: () => Promise.resolve(ensureResult),
      connectCdp: () =>
        Promise.resolve({
          evaluate: () => Promise.resolve({ value: "quickadd-main" }),
          close: () => {},
        } as never),
      ensureDeps: { adb: { execFile: () => Promise.reject(new Error("unused")) } },
    });
    expect(code).toBe(0);
    expect(streams.out.join("")).toContain("=> quickadd-main");
  });

  test("run --json emits a parseable JSON document instead of the arrow line", async () => {
    const streams = makeStreams();
    const code = await runAndroidCli(["run", "--json", "--", "eval", "code=app.vault.getName()"], {
      stdout: streams.stdout,
      stderr: streams.stderr,
      loadRunnerConfig: () => Promise.resolve(androidConfig),
      ensureAndroidInstance: () => Promise.resolve(ensureResult),
      connectCdp: () =>
        Promise.resolve({
          evaluate: () => Promise.resolve({ value: "quickadd-main" }),
          close: () => {},
        } as never),
      ensureDeps: { adb: { execFile: () => Promise.reject(new Error("unused")) } },
    });
    expect(code).toBe(0);
    expect(JSON.parse(streams.out.join(""))).toEqual({ value: "quickadd-main" });
    expect(streams.out.join("")).not.toContain("=>");
  });

  test("run rejects a non-eval command with the no-CLI explanation", async () => {
    const streams = makeStreams();
    const code = await runAndroidCli(["run", "--", "quickadd:list"], {
      stdout: streams.stdout,
      stderr: streams.stderr,
      loadRunnerConfig: () => Promise.resolve(androidConfig),
      ensureAndroidInstance: () => Promise.resolve(ensureResult),
      ensureDeps: { adb: { execFile: () => Promise.reject(new Error("unused")) } },
    });
    expect(code).toBe(1);
    expect(streams.err.join("")).toContain("no obsidian CLI on Android");
  });

  test("stop reports the no-op case", async () => {
    const streams = makeStreams();
    const code = await runAndroidCli(["stop"], {
      stdout: streams.stdout,
      stderr: streams.stderr,
      loadRunnerConfig: () => Promise.resolve(androidConfig),
      stopAndroidInstance: () => Promise.resolve({ stopped: false, serial: null }),
      ensureDeps: { adb: { execFile: () => Promise.reject(new Error("unused")) } },
    });
    expect(code).toBe(0);
    expect(streams.out.join("")).toContain('No emulator running AVD "qa-e2e"');
  });
});

describe("top-level routing", () => {
  test("`obsidian-e2e android ...` reaches the android family with injected deps", async () => {
    const streams = makeStreams();
    const code = await runObsidianE2ECli(["android", "stop"], {
      stdout: streams.stdout,
      stderr: streams.stderr,
      android: {
        loadRunnerConfig: () => Promise.resolve(androidConfig),
        stopAndroidInstance: () => Promise.resolve({ stopped: true, serial: "emulator-5554" }),
        ensureDeps: { adb: { execFile: () => Promise.reject(new Error("unused")) } },
      },
    });
    expect(code).toBe(0);
    expect(streams.out.join("")).toContain("Stopped the Android emulator emulator-5554");
  });

  test("the top-level help lists the android family", async () => {
    const streams = makeStreams();
    await runObsidianE2ECli(["--help"], { stdout: streams.stdout, stderr: streams.stderr });
    expect(streams.out.join("")).toContain("android");
  });
});

describe("parseEvalCommand", () => {
  test("accepts the desktop CLI eval spelling", () => {
    expect(parseEvalCommand(["eval", "code=1 + 1"])).toBe("1 + 1");
  });

  test("rejects anything else", () => {
    expect(parseEvalCommand(["quickadd:list"])).toBeNull();
    expect(parseEvalCommand(["eval"])).toBeNull();
  });
});
