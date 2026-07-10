import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";
import {
  pathExists,
  safeName,
  shellQuote,
  slugify,
  toShellExports,
  writeJson,
  writeJsonIfMissing,
} from "../../src/runner/fs-utils";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

describe("slugify", () => {
  test("lowercases and collapses unsupported characters", () => {
    expect(slugify("My Feature/Branch!")).toBe("my-feature-branch");
  });

  test("caps at 80 characters", () => {
    expect(slugify("a".repeat(200))).toHaveLength(80);
  });

  test("falls back to worktree when nothing usable remains", () => {
    expect(slugify("///")).toBe("worktree");
  });
});

describe("safeName", () => {
  test("keeps dots, underscores, and hyphens", () => {
    expect(safeName("QuickAdd_v1.2")).toBe("quickadd_v1.2");
  });

  test("falls back to vault when empty", () => {
    expect(safeName("!!!")).toBe("vault");
  });
});

describe("pathExists", () => {
  test("returns true for a real file and false for a missing path", async () => {
    const dir = await createTempDir(tempDirectories, "fs-utils-");
    const file = path.join(dir, "present.txt");
    await fs.writeFile(file, "hi");

    await expect(pathExists(file)).resolves.toBe(true);
    await expect(pathExists(path.join(dir, "absent.txt"))).resolves.toBe(false);
  });

  test("returns true for a broken symlink (lstat, not stat)", async () => {
    const dir = await createTempDir(tempDirectories, "fs-utils-");
    const link = path.join(dir, "broken");
    await fs.symlink(path.join(dir, "does-not-exist"), link);

    await expect(pathExists(link)).resolves.toBe(true);
  });
});

describe("writeJson", () => {
  test("writes tab-indented JSON with a trailing newline atomically", async () => {
    const dir = await createTempDir(tempDirectories, "fs-utils-");
    const file = path.join(dir, "nested", "data.json");

    await writeJson(file, { a: 1, b: [2] });

    const contents = await fs.readFile(file, "utf8");
    expect(contents).toBe('{\n\t"a": 1,\n\t"b": [\n\t\t2\n\t]\n}\n');
    // The temp sibling is renamed away, never left behind.
    await expect(pathExists(`${file}.tmp`)).resolves.toBe(false);
  });

  test("applies an explicit mode", async () => {
    const dir = await createTempDir(tempDirectories, "fs-utils-");
    const file = path.join(dir, "secret.json");

    await writeJson(file, {}, { mode: 0o600 });

    const stat = await fs.lstat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("refuses to write through a symlinked target", async () => {
    const dir = await createTempDir(tempDirectories, "fs-utils-");
    const target = path.join(dir, "target.json");
    await fs.writeFile(target, "original");
    const link = path.join(dir, "link.json");
    await fs.symlink(target, link);

    await expect(writeJson(link, { hijacked: true })).rejects.toThrow(
      /symlink or not a regular file/,
    );
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });
});

describe("writeJsonIfMissing", () => {
  test("skips an existing file and writes an absent one", async () => {
    const dir = await createTempDir(tempDirectories, "fs-utils-");
    const file = path.join(dir, "data.json");
    await fs.writeFile(file, "keep-me");

    await writeJsonIfMissing(file, { replaced: true });
    expect(await fs.readFile(file, "utf8")).toBe("keep-me");

    const fresh = path.join(dir, "fresh.json");
    await writeJsonIfMissing(fresh, { created: true });
    expect(JSON.parse(await fs.readFile(fresh, "utf8"))).toEqual({ created: true });
  });
});

describe("shellQuote and toShellExports", () => {
  test("single-quotes and escapes embedded quotes", () => {
    expect(shellQuote("it's a path")).toBe("'it'\\''s a path'");
  });

  test("renders export lines", () => {
    expect(
      toShellExports([
        { name: "OBSIDIAN_E2E_VAULT", value: "dev" },
        { name: "OBSIDIAN_E2E_VAULT_PATH", value: "/tmp/vaults/dev" },
      ]),
    ).toBe("export OBSIDIAN_E2E_VAULT='dev'\nexport OBSIDIAN_E2E_VAULT_PATH='/tmp/vaults/dev'");
  });
});
