import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";
import { CONFIG_FILE_NAME, loadRunnerConfig, resolveRunnerConfig } from "../../src/runner/config";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

async function writeConfig(worktree: string, body: string, fileName = CONFIG_FILE_NAME) {
  await fs.writeFile(path.join(worktree, fileName), body);
}

describe("loadRunnerConfig", () => {
  test("reads a default export and applies every default", async () => {
    const worktree = await createTempDir(tempDirectories, "config-");
    await writeConfig(worktree, `export default { pluginId: "podnotes" };`);

    const config = await loadRunnerConfig(worktree);

    expect(config).toEqual({
      pluginId: "podnotes",
      vaultPrefix: "podnotes",
      pluginArtifacts: ["manifest.json", "main.js"],
      defaultData: {},
      buildCommand: "npm run build",
      defaultCommand: ["eval", "code=app.vault.getName()"],
      readyProbe: {
        kind: "eval",
        code: 'Boolean(app.plugins.plugins["podnotes"])',
        match: "=> true",
      },
      envPrefix: undefined,
      profileRoot: "/tmp/podnotes-obsidian-e2e",
      appName: "Obsidian",
      obsidianBin: "obsidian",
    });
    // The default probe code must never embed its own match sentinel.
    expect(config.readyProbe.match).toBe("=> true");
    if (config.readyProbe.kind === "eval") {
      expect(config.readyProbe.code).not.toContain("=> true");
    }
  });

  test("accepts a named config export and honors overrides", async () => {
    const worktree = await createTempDir(tempDirectories, "config-");
    await writeConfig(
      worktree,
      `export const config = {
         pluginId: "metaedit",
         pluginArtifacts: ["manifest.json", "main.js", "styles.css"],
         defaultCommand: ["metaedit:list"],
         envPrefix: "METAEDIT",
         appName: "Obsidian Beta",
       };`,
    );

    const config = await loadRunnerConfig(worktree);

    expect(config.vaultPrefix).toBe("metaedit");
    expect(config.pluginArtifacts).toEqual(["manifest.json", "main.js", "styles.css"]);
    expect(config.defaultCommand).toEqual(["metaedit:list"]);
    expect(config.envPrefix).toBe("METAEDIT");
    expect(config.appName).toBe("Obsidian Beta");
  });

  test("loads from an explicit config path", async () => {
    const worktree = await createTempDir(tempDirectories, "config-");
    await writeConfig(worktree, `export default { pluginId: "quickadd" };`, "custom.config.mjs");

    const config = await loadRunnerConfig(worktree, path.join(worktree, "custom.config.mjs"));
    expect(config.pluginId).toBe("quickadd");
  });

  test("throws a clear error when the config file is missing", async () => {
    const worktree = await createTempDir(tempDirectories, "config-");
    await expect(loadRunnerConfig(worktree)).rejects.toThrow(
      /Cannot find Obsidian E2E runner config/,
    );
  });
});

describe("resolveRunnerConfig", () => {
  test("throws when pluginId is missing", () => {
    expect(() => resolveRunnerConfig({})).toThrow(/missing required "pluginId"/);
  });

  test("throws when pluginId has an invalid charset", () => {
    expect(() => resolveRunnerConfig({ pluginId: "Quick Add" })).toThrow(/invalid pluginId/);
  });

  test("rejects a non-string entry in pluginArtifacts", () => {
    expect(() =>
      resolveRunnerConfig({ pluginId: "quickadd", pluginArtifacts: ["main.js", 1] }),
    ).toThrow(/invalid "pluginArtifacts"/);
  });

  test("resolves a command readyProbe", () => {
    const config = resolveRunnerConfig({
      pluginId: "quickadd",
      readyProbe: { kind: "command", args: ["quickadd:list"], match: '"ok":true' },
    });
    expect(config.readyProbe).toEqual({
      kind: "command",
      args: ["quickadd:list"],
      match: '"ok":true',
    });
  });
});

describe("resolveRunnerConfig android block", () => {
  test("is absent when the config has no android block", () => {
    expect(resolveRunnerConfig({ pluginId: "quickadd" }).android).toBeUndefined();
  });

  test("resolves defaults around the one required field", () => {
    const config = resolveRunnerConfig({ pluginId: "quickadd", android: { avd: "qa-e2e" } });
    expect(config.android).toEqual({
      avd: "qa-e2e",
      apk: undefined,
      adbBin: "adb",
      emulatorBin: "emulator",
      cdpPort: 9222,
      bootTimeoutMs: 240_000,
    });
  });

  test("keeps explicit values", () => {
    const config = resolveRunnerConfig({
      pluginId: "quickadd",
      android: {
        avd: "qa-e2e",
        apk: "/apks/Obsidian.apk",
        adbBin: "/sdk/adb",
        emulatorBin: "/sdk/emulator",
        cdpPort: 9333,
        bootTimeoutMs: 60_000,
      },
    });
    expect(config.android?.apk).toBe("/apks/Obsidian.apk");
    expect(config.android?.cdpPort).toBe(9333);
    expect(config.android?.bootTimeoutMs).toBe(60_000);
  });

  test("rejects a missing avd", () => {
    expect(() => resolveRunnerConfig({ pluginId: "quickadd", android: {} })).toThrow(
      /invalid "android.avd"/,
    );
  });

  test("rejects a non-integer cdpPort", () => {
    expect(() =>
      resolveRunnerConfig({ pluginId: "quickadd", android: { avd: "a", cdpPort: "9222" } }),
    ).toThrow(/invalid "android.cdpPort"/);
  });
});
