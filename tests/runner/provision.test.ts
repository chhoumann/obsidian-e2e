import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { cleanupTempDirectories, createTempDir } from "../helpers/create-temp-dir";
import { parseArgs, SHARED_BOOLEAN_OPTIONS, SHARED_VALUE_OPTIONS } from "../../src/runner/args";
import {
  DEFAULT_ROOT,
  linkPluginFile,
  provisionShellExports,
  provisionVault,
  resolveProvisionOptions,
} from "../../src/runner/provision";
import type { ProvisionRawOptions, ResolvedRunnerConfig } from "../../src/runner/types";

const tempDirectories: string[] = [];

afterEach(async () => {
  await cleanupTempDirectories(tempDirectories);
});

function makeConfig(overrides: Partial<ResolvedRunnerConfig> = {}): ResolvedRunnerConfig {
  const pluginId = overrides.pluginId ?? "podnotes";
  return {
    pluginId,
    vaultPrefix: pluginId,
    pluginArtifacts: ["manifest.json", "main.js"],
    defaultData: { seeded: true, choices: [] },
    buildCommand: "npm run build",
    defaultCommand: ["eval", "code=app.vault.getName()"],
    readyProbe: {
      kind: "eval",
      code: `Boolean(app.plugins.plugins[${JSON.stringify(pluginId)}])`,
      match: "=> true",
    },
    profileRoot: `/tmp/${pluginId}-obsidian-e2e`,
    appName: "Obsidian",
    obsidianBin: "obsidian",
    ...overrides,
  };
}

const parseSpec = { valueOptions: SHARED_VALUE_OPTIONS, booleanOptions: SHARED_BOOLEAN_OPTIONS };

function parseRawOptions(argv: string[]): ProvisionRawOptions {
  return parseArgs(argv, parseSpec).options as ProvisionRawOptions;
}

async function seedWorktree(dir: string, artifacts: readonly string[], label: string) {
  await fs.mkdir(dir, { recursive: true });
  for (const fileName of artifacts) {
    await fs.writeFile(path.join(dir, fileName), `/* ${fileName} for ${label} */\n`);
  }
}

async function readLinkedTarget(filePath: string) {
  return path.resolve(path.dirname(filePath), await fs.readlink(filePath));
}

interface Scenario {
  name: string;
  pluginId: string;
  artifacts: string[];
  /** An artifact this config does NOT list, which must never be linked. */
  unlisted: string;
}

const scenarios: Scenario[] = [
  {
    name: "podnotes (no styles.css)",
    pluginId: "podnotes",
    artifacts: ["manifest.json", "main.js"],
    unlisted: "styles.css",
  },
  {
    name: "metaedit (with styles.css)",
    pluginId: "metaedit",
    artifacts: ["manifest.json", "main.js", "styles.css"],
    unlisted: "extra.js",
  },
];

for (const scenario of scenarios) {
  const config = makeConfig({ pluginId: scenario.pluginId, pluginArtifacts: scenario.artifacts });

  describe(`provisionVault - ${scenario.name}`, () => {
    test("parses vault and root options against cwd", () => {
      const options = resolveProvisionOptions(
        parseRawOptions(["--vault", `${scenario.pluginId}-a`, "--root", "vaults"]),
        config,
        "/tmp/repo",
      );

      expect(options.vaultName).toBe(`${scenario.pluginId}-a`);
      expect(options.rootPath).toBe("/tmp/repo/vaults");
      expect(options.vaultPath).toBe(`/tmp/repo/vaults/${scenario.pluginId}-a`);
    });

    test(`defaults the vault name to ${scenario.pluginId}-<worktree>`, () => {
      const options = resolveProvisionOptions(
        parseRawOptions([]),
        config,
        "/tmp/repos/devx-worktree-vault-isolation",
      );

      expect(options.vaultName).toBe(`${scenario.pluginId}-devx-worktree-vault-isolation`);
    });

    test("anchors the default vault root to the worktree, not cwd", () => {
      // --worktree elsewhere without --root must keep the vault inside that
      // checkout (worktree-local isolation), not the caller's cwd. This is the
      // regression that pins the quickadd bug.
      const options = resolveProvisionOptions(
        parseRawOptions(["--worktree", "/tmp/other/checkout"]),
        config,
        "/tmp/caller-cwd",
      );

      expect(options.rootPath).toBe(`/tmp/other/checkout/${DEFAULT_ROOT}`);
      expect(options.vaultPath).toBe(
        `/tmp/other/checkout/${DEFAULT_ROOT}/${scenario.pluginId}-checkout`,
      );
    });

    test("creates a vault with exactly the configured artifacts symlinked", async () => {
      const root = await createTempDir(tempDirectories, "provision-root-");
      const worktree = await createTempDir(tempDirectories, "provision-worktree-");
      await seedWorktree(worktree, scenario.artifacts, "a");

      const options = resolveProvisionOptions(
        { root, vault: `${scenario.pluginId}-a`, worktree },
        config,
      );
      const result = await provisionVault(options, config);
      const pluginPath = path.join(result.vaultPath, ".obsidian", "plugins", scenario.pluginId);

      await expect(
        fs.readFile(path.join(result.vaultPath, ".obsidian", "community-plugins.json"), "utf8"),
      ).resolves.toBe(`[\n\t"${scenario.pluginId}"\n]\n`);

      // Every configured artifact is linked back to the worktree...
      for (const fileName of scenario.artifacts) {
        await expect(readLinkedTarget(path.join(pluginPath, fileName))).resolves.toBe(
          path.join(worktree, fileName),
        );
      }
      // ...and an unlisted artifact is never created (generalizes the podnotes
      // styles.css ENOENT assertion, config-driven).
      await expect(fs.lstat(path.join(pluginPath, scenario.unlisted))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const seededData = JSON.parse(await fs.readFile(path.join(pluginPath, "data.json"), "utf8"));
      expect(seededData).toEqual(config.defaultData);
    });

    test("keeps separately provisioned worktrees isolated", async () => {
      const root = await createTempDir(tempDirectories, "provision-root-");
      const worktreeA = await createTempDir(tempDirectories, "provision-worktree-a-");
      const worktreeB = await createTempDir(tempDirectories, "provision-worktree-b-");
      await seedWorktree(worktreeA, scenario.artifacts, "a");
      await seedWorktree(worktreeB, scenario.artifacts, "b");

      const resultA = await provisionVault(
        resolveProvisionOptions(
          { root, vault: `${scenario.pluginId}-a`, worktree: worktreeA },
          config,
        ),
        config,
      );
      const resultB = await provisionVault(
        resolveProvisionOptions(
          { root, vault: `${scenario.pluginId}-b`, worktree: worktreeB },
          config,
        ),
        config,
      );

      const mainA = path.join(
        resultA.vaultPath,
        ".obsidian",
        "plugins",
        scenario.pluginId,
        "main.js",
      );
      const mainB = path.join(
        resultB.vaultPath,
        ".obsidian",
        "plugins",
        scenario.pluginId,
        "main.js",
      );

      await expect(readLinkedTarget(mainA)).resolves.toBe(path.join(worktreeA, "main.js"));
      await expect(readLinkedTarget(mainB)).resolves.toBe(path.join(worktreeB, "main.js"));
      expect(resultA.vaultPath).not.toBe(resultB.vaultPath);
    });

    test("copies a --data seed verbatim and never overwrites existing data", async () => {
      const root = await createTempDir(tempDirectories, "provision-root-");
      const worktree = await createTempDir(tempDirectories, "provision-worktree-");
      const seedDir = await createTempDir(tempDirectories, "provision-seed-");
      const seedData = path.join(seedDir, "data.json");
      await seedWorktree(worktree, scenario.artifacts, "a");
      await fs.writeFile(seedData, '{"seed":true}\n');

      const options = resolveProvisionOptions(
        { data: seedData, root, vault: `${scenario.pluginId}-data`, worktree },
        config,
      );

      const result = await provisionVault(options, config);
      const dataPath = path.join(result.pluginPath, "data.json");
      // First provision with --data copies the seed verbatim (not defaultData).
      await expect(fs.readFile(dataPath, "utf8")).resolves.toBe('{"seed":true}\n');

      await fs.writeFile(dataPath, '{"kept":true}\n');
      await provisionVault(options, config);

      await expect(fs.readFile(dataPath, "utf8")).resolves.toBe('{"kept":true}\n');
    });

    test("fails fast when the worktree has no built plugin artifacts", async () => {
      const root = await createTempDir(tempDirectories, "provision-root-");
      const worktree = await createTempDir(tempDirectories, "provision-worktree-empty-");

      const missing = scenario.artifacts.map((a) => a.replace(".", "\\.")).join(", ");
      await expect(
        provisionVault(
          resolveProvisionOptions({ root, vault: `${scenario.pluginId}-empty`, worktree }, config),
          config,
        ),
      ).rejects.toThrow(new RegExp(`missing ${missing}\\. Run npm run build`));
    });
  });
}

describe("linkPluginFile reconcile paths", () => {
  test("is a no-op when the correct symlink already exists", async () => {
    const dir = await createTempDir(tempDirectories, "link-");
    const source = path.join(dir, "main.js");
    const dest = path.join(dir, "linked.js");
    await fs.writeFile(source, "// source");
    await fs.symlink(source, dest);

    await expect(linkPluginFile(source, dest, false)).resolves.toBeUndefined();
    expect(await readLinkedTarget(dest)).toBe(source);
  });

  test("throws when the symlink points elsewhere and force is not set", async () => {
    const dir = await createTempDir(tempDirectories, "link-");
    const source = path.join(dir, "main.js");
    const other = path.join(dir, "other.js");
    const dest = path.join(dir, "linked.js");
    await fs.writeFile(source, "// source");
    await fs.writeFile(other, "// other");
    await fs.symlink(other, dest);

    await expect(linkPluginFile(source, dest, false)).rejects.toThrow(/Use --force to relink it/);
    // The wrong link is left untouched, not clobbered.
    expect(await readLinkedTarget(dest)).toBe(other);
  });

  test("relinks a wrong symlink when force is set", async () => {
    const dir = await createTempDir(tempDirectories, "link-");
    const source = path.join(dir, "main.js");
    const other = path.join(dir, "other.js");
    const dest = path.join(dir, "linked.js");
    await fs.writeFile(source, "// source");
    await fs.writeFile(other, "// other");
    await fs.symlink(other, dest);

    await linkPluginFile(source, dest, true);
    expect(await readLinkedTarget(dest)).toBe(source);
  });

  test("throws when the destination is a real file, even reviewing it needs --force", async () => {
    const dir = await createTempDir(tempDirectories, "link-");
    const source = path.join(dir, "main.js");
    const dest = path.join(dir, "linked.js");
    await fs.writeFile(source, "// source");
    await fs.writeFile(dest, "// real file");

    await expect(linkPluginFile(source, dest, false)).rejects.toThrow(
      /exists and is not a symlink/,
    );
    // The real file is preserved.
    expect(await fs.readFile(dest, "utf8")).toBe("// real file");
  });
});

describe("provisionShellExports", () => {
  const result = {
    pluginPath: "/vaults/dev/.obsidian/plugins/podnotes",
    vaultName: "podnotes-dev",
    vaultPath: "/vaults/podnotes-dev",
    worktreePath: "/repo",
  };

  test("emits only canonical export lines when no envPrefix is set", () => {
    const output = provisionShellExports(result, makeConfig());
    const lines = output.split("\n");

    expect(lines).toEqual([
      "export OBSIDIAN_E2E_VAULT='podnotes-dev'",
      "export OBSIDIAN_E2E_VAULT_PATH='/vaults/podnotes-dev'",
    ]);
    // Every emitted line is a bare `export NAME=value` assignment - nothing that
    // `eval "$(...)"` could execute as a stray command.
    for (const line of lines) {
      expect(line).toMatch(/^export [A-Z0-9_]+='.*'$/);
    }
  });

  test("adds legacy prefixed aliases when envPrefix is configured", () => {
    const output = provisionShellExports(result, makeConfig({ envPrefix: "PODNOTES" }));

    expect(output.split("\n")).toEqual([
      "export OBSIDIAN_E2E_VAULT='podnotes-dev'",
      "export OBSIDIAN_E2E_VAULT_PATH='/vaults/podnotes-dev'",
      "export PODNOTES_E2E_VAULT='podnotes-dev'",
      "export PODNOTES_E2E_VAULT_PATH='/vaults/podnotes-dev'",
    ]);
  });
});
