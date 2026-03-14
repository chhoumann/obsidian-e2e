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
  - `createPluginTest()`
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

## Shared Vault Locking

If multiple worktrees or separate test runs all point at the same
`obsidian vault=dev` vault, you can enable `sharedVaultLock` to serialize access
across those runs:

```ts
import { createObsidianTest, createPluginTest } from "obsidian-e2e/vitest";

export const test = createObsidianTest({
  vault: "dev",
  sharedVaultLock: true,
});

export const pluginTest = createPluginTest({
  vault: "dev",
  pluginId: "quickadd",
  sharedVaultLock: {
    onBusy: "wait",
    timeoutMs: 60_000,
  },
});
```

`sharedVaultLock` is acquired once per worker before that worker starts using
the shared vault. The authoritative state is a host-side lock directory keyed
by the resolved vault path. That file-backed lock owns the lease, updates a
heartbeat, and allows stale-lock takeover after the configured timeout window.

For visibility inside the running app, the holder also publishes a best-effort
marker into the Obsidian process. That marker is not authoritative. The
filesystem lock is the source of truth, and the app marker is only there to
help humans understand which run currently owns the vault.

For lock diagnostics, `obsidian-e2e/vitest` also exports:

```ts
import { inspectVaultRunLock, readVaultRunLockMarker } from "obsidian-e2e/vitest";

const state = await inspectVaultRunLock({
  vaultPath: "/absolute/path/to/dev-vault",
});

const marker = await readVaultRunLockMarker(obsidian);
```

`inspectVaultRunLock()` reads the authoritative host-side lock state and
returns the current metadata, lock directory, heartbeat age, and stale status.
`readVaultRunLockMarker()` reads the best-effort marker from the running
Obsidian app.

Within one worker/process, reacquiring the same shared-vault lock is reentrant:
the existing lease is reused instead of contending against itself. Across
different processes or worktrees, contention still serializes access through
the host-side lock.

This mode prevents collisions between concurrent runs that share one live
vault, but it does not create true parallel execution inside that vault. It
serializes access. If your goal is real parallelism, use separate vaults rather
than one shared `vault: "dev"` target.

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
  - low-level access to `app`, `command(id)`, `commands()`, `exec`, `execText`,
    `execJson`, `waitFor`, `vaultPath`, and `plugin(id)`
- `vault`
  - reads and writes anywhere in the vault rooted at the active Obsidian vault
- `sandbox`
  - a per-test disposable directory under `sandboxRoot`; automatically cleaned
    up after each test

Plugin data mutations are snapshotted on first write and restored automatically
after each test. Sandbox files are also cleaned up automatically.

## Plugin Test Helper

If you are testing one plugin repeatedly, `createPluginTest()` gives you a
first-class `plugin` fixture and optional seed helpers for vault files and
plugin data:

```ts
import { createPluginTest } from "obsidian-e2e/vitest";

export const test = createPluginTest({
  vault: "dev",
  pluginId: "quickadd",
  pluginFilter: "community",
  seedPluginData: { enabled: true },
  seedVault: {
    "fixtures/template.md": "template body",
    "fixtures/state.json": { json: { ready: true } },
  },
});
```

`createPluginTest()`:

- injects `plugin` alongside `obsidian`, `vault`, and `sandbox`
- enables the target plugin for the test when needed and restores the prior
  enabled/disabled state afterward
- seeds vault files before each test and restores the original files afterward
- seeds `data.json` through the normal plugin snapshot/restore path
- supports the same opt-in failure artifact capture as `createObsidianTest()`

Example:

```ts
import { expect } from "vite-plus/test";
import { test } from "./setup";

test("runs against a seeded plugin fixture", async ({ plugin, vault }) => {
  await expect(plugin.data<{ enabled: boolean }>().read()).resolves.toEqual({
    enabled: true,
  });
  await expect(vault.read("fixtures/template.md")).resolves.toBe("template body");

  await plugin.reload();
});
```

## Failure Artifacts

Both fixture families support opt-in artifact capture:

- `createObsidianTest({ artifactsDir, captureOnFailure })`
- `createPluginTest({ artifactsDir, captureOnFailure, ... })`

Example:

```ts
import { createObsidianTest, createPluginTest } from "obsidian-e2e/vitest";

export const test = createObsidianTest({
  vault: "dev",
  captureOnFailure: true,
});

export const pluginTest = createPluginTest({
  vault: "dev",
  pluginId: "quickadd",
  artifactsDir: ".artifacts",
  captureOnFailure: {
    screenshot: false,
  },
});
```

When `captureOnFailure` is enabled, failed tests write artifacts under
`.obsidian-e2e-artifacts` by default, or under `artifactsDir` if you set one.
Each failed test gets its own directory named from the test name plus a stable
task-id suffix, for example:

```txt
.obsidian-e2e-artifacts/
  writes-useful-artifacts-abcdef12/
```

`createObsidianTest()` captures:

- `active-file.json`
- `dom.txt`
- `editor.json`
- `tabs.json`
- `workspace.json`
- `screenshot.png` when screenshot capture succeeds

`createPluginTest()` adds:

- `<pluginId>-data.json`

Artifact collection is best-effort. If a specific capture fails, the test still
fails for its original reason and the framework writes a neighboring
`*.error.txt` file instead. Screenshot capture is the most environment-sensitive
part of the set: desktop permissions, display availability, or Obsidian state
can prevent `screenshot.png` from being produced, in which case you should
expect `screenshot.error.txt` instead.

## Maintainer CI And Releases

This repo now ships with a hardened CI and release flow built around Vite+
workflow setup, Changesets release orchestration, and npm trusted publishing
through GitHub OIDC.

At a high level:

- CI installs the toolchain with `setup-vp`, then runs `vp check`,
  `vp test`, and `vp pack`.
- When CI fails after artifact capture is enabled in tests, it uploads
  `.obsidian-e2e-artifacts` so maintainers can inspect the same failure
  snapshots produced locally.
- Releases go through Changesets PRs. Merge the version PR that
  Changesets opens, then let the release workflow publish to npm.

Maintainer setup notes:

- Configure npm trusted publishing for this package and repository so the
  GitHub release workflow can publish without a long-lived npm token.
- Grant the publish job `id-token: write` so GitHub can mint the OIDC token npm
  expects, and keep the release workflow permissions aligned with the write
  actions it needs, such as `contents: write` and `pull-requests: write` for
  Changesets automation.
- If you protect publishing behind a GitHub environment, attach that
  environment to the release job and allow the workflow to use it.

## Matchers

Import `obsidian-e2e/matchers` once in your test setup to register:

- `toHaveActiveFile(path)`
- `toHaveCommand(commandId)`
- `toHaveEditorTextContaining(needle)`
- `toHaveFile(path)`
- `toHaveFileContaining(path, needle)`
- `toHaveJsonFile(path)`
- `toHaveOpenTab(title, viewType?)`
- `toHavePluginData(expected)`
- `toHaveWorkspaceNode(label)`

Example:

```ts
import { expect } from "vite-plus/test";
import { test } from "./setup";

test("writes valid JSON into the sandbox", async ({ sandbox }) => {
  await sandbox.json("config.json").write({ enabled: true });

  await expect(sandbox).toHaveJsonFile("config.json");
});

test("asserts active Obsidian state", async ({ obsidian, plugin }) => {
  await expect(obsidian).toHaveCommand("quickadd:run-choice");
  await expect(obsidian).toHaveActiveFile("Inbox/Today.md");
  await expect(obsidian).toHaveEditorTextContaining("Today");
  await expect(obsidian).toHaveOpenTab("Today", "markdown");
  await expect(obsidian).toHaveWorkspaceNode("main");
  await expect(plugin).toHavePluginData({ enabled: true });
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

## App And Commands

The client now exposes app-level helpers and command helpers that map directly
to the real `obsidian` CLI:

- `obsidian.app.version()`
- `obsidian.app.reload()`
- `obsidian.app.restart()`
- `obsidian.app.waitUntilReady()`
- `obsidian.commands({ filter? })`
- `obsidian.command(id).exists()`
- `obsidian.command(id).run()`
- `obsidian.dev.dom({ ... })`
- `obsidian.dev.eval(code)`
- `obsidian.dev.screenshot(path)`
- `obsidian.tabs()`
- `obsidian.workspace()`
- `obsidian.open({ file? | path?, newTab? })`
- `obsidian.openTab({ file?, group?, view? })`

Example:

```ts
import { expect } from "vite-plus/test";
import { test } from "./setup";

test("reloads the app and runs a plugin command when it becomes available", async ({
  obsidian,
}) => {
  await obsidian.app.waitUntilReady();

  const commandId = "quickadd:run-choice";

  if (await obsidian.command(commandId).exists()) {
    await obsidian.command(commandId).run();
  }

  await obsidian.app.reload();

  await expect(obsidian.commands({ filter: "quickadd:" })).resolves.toContain(commandId);
});
```

`obsidian.app.restart()` waits for the app to come back by default. Pass
`{ waitUntilReady: false }` if you need to manage readiness explicitly.

Workspace and tab readers return parsed structures, so you can inspect layout
state without writing custom parsers in every test:

```ts
test("opens a note into a new tab and finds it in the workspace", async ({ obsidian }) => {
  await obsidian.open({
    newTab: true,
    path: "Inbox/Today.md",
  });

  const tabs = await obsidian.tabs();
  const workspace = await obsidian.workspace();

  expect(tabs.some((tab) => tab.title === "Today")).toBe(true);
  expect(workspace.some((node) => node.label === "main")).toBe(true);
});
```

For deeper UI inspection, the `dev` namespace exposes the desktop developer
commands:

```ts
test("inspects live UI state", async ({ obsidian }) => {
  const titles = await obsidian.dev.dom({
    all: true,
    selector: ".workspace-tab-header-inner-title",
    text: true,
  });

  expect(titles).toContain("Today");

  await obsidian.dev.screenshot("artifacts/today.png");
});
```

`obsidian.dev.eval()` is the low-level escape hatch, while `dev.dom()` and
`dev.screenshot()` give you safer wrappers around the built-in developer CLI
commands. Screenshot behavior depends on the active desktop environment, so
start by validating it locally before relying on it in automation.

## End-To-End Workflow

Putting it together, a realistic plugin test usually looks like this:

```ts
import { expect } from "vite-plus/test";
import { createPluginTest } from "obsidian-e2e/vitest";
import "obsidian-e2e/matchers";

const test = createPluginTest({
  vault: "dev",
  pluginId: "quickadd",
  pluginFilter: "community",
  seedPluginData: {
    macros: [],
  },
  seedVault: {
    "fixtures/template.md": "Hello from template",
    "Inbox/Today.md": "# Today\n",
  },
});

test("runs a seeded workflow end to end", async ({ obsidian, plugin, vault }) => {
  await expect(obsidian).toHaveCommand("quickadd:run-choice");
  await expect(plugin).toHavePluginData({
    macros: [],
  });

  if (await obsidian.command("quickadd:run-choice").exists()) {
    await obsidian.command("quickadd:run-choice").run();
  }

  await obsidian.open({
    path: "Inbox/Today.md",
  });

  await expect(obsidian).toHaveActiveFile("Inbox/Today.md");
  await expect(vault).toHaveFile("fixtures/template.md");

  const headers = await obsidian.dev.dom({
    all: true,
    selector: ".workspace-tab-header-inner-title",
    text: true,
  });

  expect(headers).toContain("Today");
});
```

That pattern keeps tests readable:

- use `createPluginTest()` when one plugin is the main subject under test
- seed only the files and plugin data needed for that case
- prefer Obsidian-aware matchers over ad hoc CLI parsing
- drop to `obsidian.dev.*` only when filesystem and command assertions are not enough

## Notes

- This package is a testing library, not a custom runner.
- It is designed for real Obsidian-backed integration and e2e flows, not for
  mocked unit tests.
- Headless CI for desktop Obsidian is environment-specific; start by getting
  tests reliable locally before automating them.
