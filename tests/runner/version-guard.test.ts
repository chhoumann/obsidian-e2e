import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { buildAsar, makeConfigDir, makeWorktreeWithManifest } from "../helpers/asar";
import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";
import {
  assertObsidianMeetsMinAppVersion,
  compareObsidianVersions,
  reconcileSandboxAppAsar,
  resolveObsidianAppVersion,
} from "../../src/runner/version-guard";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

describe("compareObsidianVersions", () => {
  test("orders by major, minor, then patch and ignores suffixes", () => {
    expect(compareObsidianVersions("1.13.0", "1.13.0")).toBe(0);
    expect(compareObsidianVersions("1.13.1", "1.13.0")).toBeGreaterThan(0);
    expect(compareObsidianVersions("1.12.7", "1.13.0")).toBeLessThan(0);
    expect(compareObsidianVersions("1.13.0-insider", "1.13.0")).toBe(0);
    expect(compareObsidianVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });
});

describe("resolveObsidianAppVersion", () => {
  test("picks the newest installed asar in the config dir", async () => {
    const configDir = await makeConfigDir(tempDirectories, ["1.12.7", "1.13.0"]);
    const resolved = await resolveObsidianAppVersion({
      obsidianConfigDir: configDir,
      bundledAsarCandidates: [],
    });
    expect(resolved.appVersion).toBe("1.13.0");
    expect(resolved.cachedVersions.sort()).toEqual(["1.12.7", "1.13.0"]);
    // The seeding step copies exactly this file (single resolver authority).
    expect(resolved.newestCachedAsar).toEqual({
      name: "obsidian-1.13.0.asar",
      path: path.join(configDir, "obsidian-1.13.0.asar"),
      version: "1.13.0",
    });
  });

  test("floors at the bundled installer asar when the config dir is empty", async () => {
    const configDir = await makeConfigDir(tempDirectories, []);
    const bundled = path.join(
      await createTempDir(tempDirectories, "obsidian-app-"),
      "obsidian.asar",
    );
    await fs.writeFile(bundled, buildAsar("1.12.7"));
    const resolved = await resolveObsidianAppVersion({
      obsidianConfigDir: configDir,
      bundledAsarCandidates: [bundled],
    });
    expect(resolved.appVersion).toBe("1.12.7");
    expect(resolved.installerVersion).toBe("1.12.7");
  });

  test("returns null appVersion when nothing can be determined", async () => {
    const configDir = await makeConfigDir(tempDirectories, []);
    const resolved = await resolveObsidianAppVersion({
      obsidianConfigDir: configDir,
      bundledAsarCandidates: [path.join(configDir, "does-not-exist.asar")],
    });
    expect(resolved.appVersion).toBeNull();
  });

  test("skips a partial/corrupt cached asar instead of trusting its filename", async () => {
    const configDir = await makeConfigDir(tempDirectories, ["1.12.7"]);
    await fs.writeFile(path.join(configDir, "obsidian-1.13.0.asar"), "not-a-real-asar");
    const resolved = await resolveObsidianAppVersion({
      obsidianConfigDir: configDir,
      bundledAsarCandidates: [],
    });
    expect(resolved.appVersion).toBe("1.12.7");
    expect(resolved.cachedVersions).toEqual(["1.12.7"]);
  });

  test("reads the asar version at every header-length 4-byte alignment residue", async () => {
    // Real asar headers are arbitrary lengths; the parser must not assume the
    // header JSON is 4-byte aligned. Cover all four residues - a reader that uses
    // `16 + jsonLength` instead of the header pickle size misreads three of these.
    const residues = new Set<number>();
    for (let pad = 0; pad < 4; pad++) {
      const asar = buildAsar("1.13.0", pad);
      residues.add(asar.readUInt32LE(12) % 4);
      const dir = await createTempDir(tempDirectories, "asar-align-");
      await fs.writeFile(path.join(dir, "obsidian-1.13.0.asar"), asar);
      const resolved = await resolveObsidianAppVersion({
        obsidianConfigDir: dir,
        bundledAsarCandidates: [],
      });
      expect(resolved.appVersion, `pad=${pad}`).toBe("1.13.0");
    }
    // Guard the guard: prove the four builds really span all four residues.
    expect(residues).toEqual(new Set([0, 1, 2, 3]));
  });
});

describe("reconcileSandboxAppAsar", () => {
  test("seeds the newest cached asar and removes stale ones", async () => {
    const configDir = await makeConfigDir(tempDirectories, ["1.13.0"]);
    const sandbox = await createTempDir(tempDirectories, "sandbox-");
    // A leftover older asar from a previous run must be removed so it can't
    // outrank the prediction.
    await fs.writeFile(path.join(sandbox, "obsidian-1.11.0.asar"), buildAsar("1.11.0"));

    const seeded = await reconcileSandboxAppAsar(sandbox, {
      name: "obsidian-1.13.0.asar",
      path: path.join(configDir, "obsidian-1.13.0.asar"),
      version: "1.13.0",
    });

    expect(seeded).toBe("1.13.0");
    await expect(fs.stat(path.join(sandbox, "obsidian-1.13.0.asar"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(sandbox, "obsidian-1.11.0.asar"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("skips the copy when an equally-sized asar is already seeded", async () => {
    const configDir = await makeConfigDir(tempDirectories, ["1.13.0"]);
    const sandbox = await createTempDir(tempDirectories, "sandbox-");
    const destination = path.join(sandbox, "obsidian-1.13.0.asar");
    // Pre-seed with identical bytes, then a distinguishing mtime marker: a skipped
    // copy leaves the file untouched (proving we don't rewrite ~25MB per command).
    await fs.copyFile(path.join(configDir, "obsidian-1.13.0.asar"), destination);
    const before = await fs.stat(destination);

    const seeded = await reconcileSandboxAppAsar(sandbox, {
      name: "obsidian-1.13.0.asar",
      path: path.join(configDir, "obsidian-1.13.0.asar"),
      version: "1.13.0",
    });

    expect(seeded).toBe("1.13.0");
    const after = await fs.stat(destination);
    expect(after.ino).toBe(before.ino);
  });

  test("leaves the sandbox clean and returns null when no asar is cached", async () => {
    const sandbox = await createTempDir(tempDirectories, "sandbox-");
    await fs.writeFile(path.join(sandbox, "obsidian-1.11.0.asar"), buildAsar("1.11.0"));

    const seeded = await reconcileSandboxAppAsar(sandbox, null);

    expect(seeded).toBeNull();
    await expect(fs.stat(path.join(sandbox, "obsidian-1.11.0.asar"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("assertObsidianMeetsMinAppVersion", () => {
  test("passes when the running app meets minAppVersion (green)", async () => {
    const worktreePath = await makeWorktreeWithManifest(tempDirectories, "1.13.0");
    const configDir = await makeConfigDir(tempDirectories, ["1.12.7", "1.13.0"]);
    await expect(
      assertObsidianMeetsMinAppVersion({
        worktreePath,
        obsidianConfigDir: configDir,
        bundledAsarCandidates: [],
      }),
    ).resolves.toEqual({
      appVersion: "1.13.0",
      installerVersion: null,
      minAppVersion: "1.13.0",
    });
  });

  test("fails loudly when Obsidian fell back below minAppVersion (red)", async () => {
    const worktreePath = await makeWorktreeWithManifest(tempDirectories, "1.13.0");
    const configDir = await makeConfigDir(tempDirectories, ["1.12.7"]);
    await expect(
      assertObsidianMeetsMinAppVersion({
        worktreePath,
        obsidianConfigDir: configDir,
        bundledAsarCandidates: [],
      }),
    ).rejects.toThrow(/1\.12\.7 is BELOW the plugin's minAppVersion 1\.13\.0/);
  });

  test("refuses to run when the app version cannot be determined", async () => {
    const worktreePath = await makeWorktreeWithManifest(tempDirectories, "1.13.0");
    const configDir = await makeConfigDir(tempDirectories, []);
    await expect(
      assertObsidianMeetsMinAppVersion({
        worktreePath,
        obsidianConfigDir: configDir,
        bundledAsarCandidates: [],
      }),
    ).rejects.toThrow(/Could not determine the running Obsidian app version/);
  });
});
