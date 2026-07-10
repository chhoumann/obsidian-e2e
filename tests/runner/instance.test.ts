import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { makeConfigDir } from "../helpers/asar";
import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";
import { resolveRunnerConfig } from "../../src/runner/config";
import {
  INSTANCE_MARKER_FILE,
  linkHostKeychains,
  prepareObsidianProfile,
  readInstanceMarker,
  resolveInstanceOptions,
  stableInstanceId,
  stampInstanceMarkerAppVersion,
  toInstanceShellExports,
} from "../../src/runner/instance";
import type { InstanceOptions, ProvisionOptions } from "../../src/runner/types";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

interface OptionOverrides {
  vaultName?: string;
  worktreePath?: string;
  profileRoot?: string;
  pluginId?: string;
  obsidianBin?: string;
}

/**
 * Build resolved {@link InstanceOptions} without importing the provision module
 * (owned by R2): construct the {@link ProvisionOptions} inline, then delegate to
 * the real derivation. R5 will instead thread `resolveProvisionOptions` output in.
 */
function makeInstanceOptions(cwd: string, overrides: OptionOverrides = {}): InstanceOptions {
  const worktreePath = overrides.worktreePath ?? cwd;
  const vaultName = overrides.vaultName ?? "quickadd-worktree-a";
  const rootPath = path.join(worktreePath, ".obsidian-e2e-vaults");
  const vaultPath = path.join(rootPath, vaultName);
  const provision: ProvisionOptions = {
    dataPath: undefined,
    force: false,
    json: false,
    printEnv: false,
    rootPath,
    vaultName,
    vaultPath,
    worktreePath,
  };
  const config = resolveRunnerConfig({ pluginId: overrides.pluginId ?? "quickadd" });
  return resolveInstanceOptions(
    provision,
    { launch: false, profileRoot: overrides.profileRoot, obsidianBin: overrides.obsidianBin },
    config,
    cwd,
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("resolveInstanceOptions", () => {
  test("derives instance paths, defaults, and userDataPath from provision + config", () => {
    const cwd = "/tmp/does-not-need-to-exist";
    const options = makeInstanceOptions(cwd, {
      vaultName: "quickadd-worktree-a",
      profileRoot: "profiles",
    });

    expect(options.instanceId).toBe(stableInstanceId(options.worktreePath, options.vaultName));
    expect(options.profileRoot).toBe(path.join(cwd, "profiles"));
    expect(options.instancePath).toBe(path.join(cwd, "profiles", options.instanceId));
    expect(options.obsidianHome).toBe(path.join(options.instancePath, "home"));
    expect(options.userDataPath).toBe(
      path.join(options.obsidianHome, "Library", "Application Support", "obsidian"),
    );
    // Defaults come from the resolved config; launch defaults to true.
    expect(options.obsidianApp).toBe("Obsidian");
    expect(options.obsidianBin).toBe("obsidian");
    expect(makeInstanceOptions(cwd, {}).launch).toBe(false);
  });
});

describe("prepareObsidianProfile", () => {
  test("creates a private profile registered to the provisioned vault", async () => {
    const cwd = await createTempDir(tempDirectories, "instance-");
    const options = makeInstanceOptions(cwd, {
      vaultName: "quickadd-worktree-a",
      profileRoot: "profiles",
    });

    const profile = await prepareObsidianProfile({
      ...options,
      // Hermetic: never scan the real host config dir / copy a real asar.
      obsidianConfigDir: await createTempDir(tempDirectories, "empty-config-"),
      bundledAsarCandidates: [],
    });
    const registry = JSON.parse(await fs.readFile(profile.obsidianJsonPath, "utf8"));
    const vaults = Object.values(registry.vaults) as Array<{ path: string; open: boolean }>;

    expect(registry.cli).toBe(true);
    expect(registry.updateDisabled).toBe(true);
    const hostKeychains = path.join(process.env.HOME ?? "", "Library", "Keychains");
    const privateKeychains = path.join(options.obsidianHome, "Library", "Keychains");
    if (await exists(hostKeychains)) {
      await expect(fs.readlink(privateKeychains)).resolves.toBe(hostKeychains);
    } else {
      await expect(fs.lstat(privateKeychains)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(
      options.obsidianHome.startsWith(path.join(cwd, "profiles", "quickadd-worktree-a-")),
    ).toBe(true);
    expect(options.obsidianHome.endsWith("/home")).toBe(true);
    expect(vaults).toEqual([
      {
        open: true,
        path: options.vaultPath,
        ts: expect.any(Number),
      },
    ]);
  });

  test("writes the worktree marker the teardown reaper consumes (appVersion null)", async () => {
    const cwd = await createTempDir(tempDirectories, "instance-");
    const options = makeInstanceOptions(cwd, {
      vaultName: "quickadd-worktree-b",
      profileRoot: "profiles",
    });

    await prepareObsidianProfile({
      ...options,
      obsidianConfigDir: await createTempDir(tempDirectories, "empty-config-"),
      bundledAsarCandidates: [],
    });

    const marker = JSON.parse(
      await fs.readFile(path.join(options.instancePath, INSTANCE_MARKER_FILE), "utf8"),
    );
    expect(marker).toEqual({
      worktreePath: options.worktreePath,
      vaultName: options.vaultName,
      vaultPath: options.vaultPath,
      appVersion: null,
    });
    expect(path.resolve(marker.worktreePath)).toBe(path.resolve(cwd));
  });

  test("seeds the resolved asar and preserves the launch-time marker across an update", async () => {
    const cwd = await createTempDir(tempDirectories, "instance-");
    const options = makeInstanceOptions(cwd, {
      vaultName: "quickadd-worktree-seed",
      profileRoot: "profiles",
    });

    const first = await prepareObsidianProfile({
      ...options,
      obsidianConfigDir: await makeConfigDir(tempDirectories, ["1.12.7"]),
      bundledAsarCandidates: [],
    });
    await expect(
      fs.stat(path.join(first.userDataPath, "obsidian-1.12.7.asar")),
    ).resolves.toBeTruthy();
    expect(first.appVersion).toBe("1.12.7");

    // The marker records LAUNCH time - a prepared-but-never-launched profile is
    // unstamped.
    expect((await readInstanceMarker(options.instancePath))?.appVersion).toBeNull();

    // Launch happened on 1.12.7: the launch path stamps the marker.
    await stampInstanceMarkerAppVersion(options.instancePath, "1.12.7");
    expect((await readInstanceMarker(options.instancePath))?.appVersion).toBe("1.12.7");

    // Host updated: re-preparing swaps the sandbox to the new resolution and
    // removes the stale asar, but must PRESERVE the launch-time marker (blinding
    // the reuse guard otherwise).
    const second = await prepareObsidianProfile({
      ...options,
      obsidianConfigDir: await makeConfigDir(tempDirectories, ["1.13.0"]),
      bundledAsarCandidates: [],
    });
    await expect(
      fs.stat(path.join(second.userDataPath, "obsidian-1.13.0.asar")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(second.userDataPath, "obsidian-1.12.7.asar")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(second.appVersion).toBe("1.13.0");
    expect((await readInstanceMarker(options.instancePath))?.appVersion).toBe("1.12.7");
  });
});

describe("linkHostKeychains", () => {
  test("links the host keychains into the private profile", async () => {
    const host = await createTempDir(tempDirectories, "host-home-");
    await fs.mkdir(path.join(host, "Library", "Keychains"), { recursive: true });
    const profile = await createTempDir(tempDirectories, "profile-home-");

    await linkHostKeychains({ obsidianHome: profile }, host);

    const dest = path.join(profile, "Library", "Keychains");
    await expect(fs.readlink(dest)).resolves.toBe(path.join(host, "Library", "Keychains"));
  });

  test("is a no-op when HOME is already the private profile (self-ref guard)", async () => {
    const host = await createTempDir(tempDirectories, "host-home-");
    await fs.mkdir(path.join(host, "Library", "Keychains"), { recursive: true });
    const profile = await createTempDir(tempDirectories, "profile-home-");

    // First link from the real host into the profile.
    await linkHostKeychains({ obsidianHome: profile }, host);
    const dest = path.join(profile, "Library", "Keychains");

    // Now HOME IS the profile: re-linking would unlink the real host-keychain
    // symlink and replace it with a broken self-referential one. The guard must
    // leave the existing link pointing at the real host keychains.
    await linkHostKeychains({ obsidianHome: profile }, profile);
    await expect(fs.readlink(dest)).resolves.toBe(path.join(host, "Library", "Keychains"));
  });

  test("skips silently when the host keychains directory is absent", async () => {
    const host = await createTempDir(tempDirectories, "host-home-");
    const profile = await createTempDir(tempDirectories, "profile-home-");

    await linkHostKeychains({ obsidianHome: profile }, host);

    await expect(fs.lstat(path.join(profile, "Library", "Keychains"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("toInstanceShellExports", () => {
  test("emits the canonical OBSIDIAN_HOME and omits aliases by default", () => {
    const exports = toInstanceShellExports({ obsidianHome: "/tmp/home" });
    expect(exports).toContain("export OBSIDIAN_E2E_OBSIDIAN_HOME='/tmp/home'");
    expect(exports).not.toContain("_E2E_OBSIDIAN_HOME='/tmp/home'\nexport");
    expect(exports).not.toContain("OBSIDIAN_BIN");
  });

  test("emits the legacy prefix alias and non-default OBSIDIAN_BIN when configured", () => {
    const exports = toInstanceShellExports({
      obsidianHome: "/tmp/home",
      obsidianBin: "/opt/obsidian",
      envPrefix: "QUICKADD",
    });
    expect(exports).toContain("export OBSIDIAN_E2E_OBSIDIAN_HOME='/tmp/home'");
    expect(exports).toContain("export QUICKADD_E2E_OBSIDIAN_HOME='/tmp/home'");
    expect(exports).toContain("export OBSIDIAN_BIN='/opt/obsidian'");
  });

  test("omits OBSIDIAN_BIN when it is the default binary", () => {
    const exports = toInstanceShellExports({ obsidianHome: "/tmp/home", obsidianBin: "obsidian" });
    expect(exports).not.toContain("OBSIDIAN_BIN");
  });
});
