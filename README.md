# obsidian-e2e

Vitest-first end-to-end test utilities for Obsidian plugins.

`obsidian-e2e` is a thin testing library around a live Obsidian vault and the
globally installed `obsidian` CLI. It stays plugin-agnostic on purpose: you get
generic fixtures for Obsidian, vault access, and per-test sandboxes, then opt
into plugin-specific behavior through `obsidian.plugin(id)`.

## Install

```bash
pnpm add -D obsidian-e2e
```

Requirements:

- Obsidian must be installed locally.
- The `obsidian` CLI must already be available on `PATH`.
- Your target vault must be open and reachable from the CLI.

## Public Entry Points

- `obsidian-e2e`
  - low-level client and shared types
- `obsidian-e2e/vitest`
  - `createObsidianTest()`
- `obsidian-e2e/matchers`
  - optional `expect` matchers for vault and sandbox assertions

## Setup

`tests/setup.ts`

```ts
import { createObsidianTest } from "obsidian-e2e/vitest";
import "obsidian-e2e/matchers";

export const test = createObsidianTest({
  vault: "dev",
  bin: process.env.OBSIDIAN_BIN ?? "obsidian",
  sandboxRoot: "__obsidian_e2e__",
  timeoutMs: 5_000,
});
```

`vite.config.ts`

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
  },
});
```

Run Obsidian-backed tests serially. A live Obsidian app and shared vault are
not safe to hit from multiple Vitest workers at once, so `fileParallelism: false`
and `maxWorkers: 1` should be treated as the default, not as an optimization.

## Writing Tests

```ts
import { expect } from "vite-plus/test";
import { test } from "./setup";

test("reloads a plugin after patching its data file", async ({ obsidian, vault, sandbox }) => {
  const plugin = obsidian.plugin("my-plugin");

  await sandbox.write("tpl.md", "template body");
  await vault.write("notes/source.md", "existing");

  await plugin.data<{ enabled: boolean }>().patch((draft) => {
    draft.enabled = true;
  });

  await plugin.reload();

  await expect(sandbox).toHaveFile("tpl.md");
  await expect(vault).toHaveFileContaining("notes/source.md", "existing");
});
```

Fixture summary:

- `obsidian`
  - low-level access to `exec`, `execText`, `execJson`, `waitFor`, `vaultPath`,
    and `plugin(id)`
- `vault`
  - reads and writes anywhere in the vault rooted at the active Obsidian vault
- `sandbox`
  - a per-test disposable directory under `sandboxRoot`; automatically cleaned
    up after each test

Plugin data mutations are snapshotted on first write and restored automatically
after each test. Sandbox files are also cleaned up automatically.

## Matchers

Import `obsidian-e2e/matchers` once in your test setup to register:

- `toHaveFile(path)`
- `toHaveFileContaining(path, needle)`
- `toHaveJsonFile(path)`

Example:

```ts
import { expect } from "vite-plus/test";
import { test } from "./setup";

test("writes valid JSON into the sandbox", async ({ sandbox }) => {
  await sandbox.json("config.json").write({ enabled: true });

  await expect(sandbox).toHaveJsonFile("config.json");
});
```

## Low-Level Client

If you need to work below the fixture layer:

```ts
import { createObsidianClient } from "obsidian-e2e";

const obsidian = createObsidianClient({
  vault: "dev",
  bin: "obsidian",
});

await obsidian.verify();
await obsidian.exec("plugin:reload", { id: "my-plugin" });
```

## Notes

- This package is a testing library, not a custom runner.
- It is designed for real Obsidian-backed integration and e2e flows, not for
  mocked unit tests.
- Headless CI for desktop Obsidian is environment-specific; start by getting
  tests reliable locally before automating them.
