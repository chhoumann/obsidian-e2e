import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";
import { assertSecureDirIfPresent, ensureSecureDir } from "../../src/runner/security";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

describe("ensureSecureDir", () => {
  test("creates a fresh profile dir owned by us with 0o700", async () => {
    const root = await createTempDir(tempDirectories, "secure-");
    const dir = path.join(root, "profile-root");

    await ensureSecureDir(dir);

    const stat = await fs.lstat(dir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    if (typeof process.getuid === "function") {
      expect(stat.uid).toBe(process.getuid());
    }
  });

  test("rejects a pre-existing group/world-accessible dir (planted-child race)", async () => {
    const root = await createTempDir(tempDirectories, "secure-");
    const dir = path.join(root, "loose");
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o777);

    await expect(ensureSecureDir(dir)).rejects.toThrow(/group\/other-accessible/);
  });

  test("refuses a symlink at the profile path (never follows it)", async () => {
    const root = await createTempDir(tempDirectories, "secure-");
    const target = path.join(root, "attacker-owned");
    await fs.mkdir(target, { recursive: true });
    const link = path.join(root, "profile-root");
    await fs.symlink(target, link);

    await expect(ensureSecureDir(link)).rejects.toThrow(/symlink or not a regular directory/);
    // The symlink target must be untouched - we must not have written through it.
    expect((await fs.readdir(target)).length).toBe(0);
  });

  test("refuses a dir owned by a different uid (temp-squat)", async () => {
    const root = await createTempDir(tempDirectories, "secure-");
    const dir = path.join(root, "foreign");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const foreignUid = (process.getuid?.() ?? 0) + 4242;
    await expect(ensureSecureDir(dir, { currentUid: foreignUid })).rejects.toThrow(/owned by uid/);
  });

  test("skips the owner check when getuid is unavailable (currentUid null)", async () => {
    const root = await createTempDir(tempDirectories, "secure-");
    const dir = path.join(root, "no-getuid");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    await expect(ensureSecureDir(dir, { currentUid: null })).resolves.toBe(dir);
  });
});

describe("assertSecureDirIfPresent", () => {
  test("returns false for an absent dir without creating it", async () => {
    const root = await createTempDir(tempDirectories, "secure-");
    const dir = path.join(root, "missing");

    await expect(assertSecureDirIfPresent(dir)).resolves.toBe(false);
    await expect(fs.lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("accepts an existing private dir we own", async () => {
    const root = await createTempDir(tempDirectories, "secure-");
    const dir = path.join(root, "ours");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    await expect(assertSecureDirIfPresent(dir)).resolves.toBe(true);
  });

  test("refuses a symlinked profile root (teardown must not traverse it)", async () => {
    const root = await createTempDir(tempDirectories, "secure-");
    const target = path.join(root, "attacker-owned");
    await fs.mkdir(target, { recursive: true });
    const link = path.join(root, "profile-root");
    await fs.symlink(target, link);

    await expect(assertSecureDirIfPresent(link)).rejects.toThrow(
      /symlink or not a regular directory/,
    );
  });
});
