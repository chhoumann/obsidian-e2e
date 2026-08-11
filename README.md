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
  - `resolveObsidianEnvOptions()` / `verifyVaultPath()`
- `obsidian-e2e/vitest`
  - `createObsidianTest()`
  - `createPluginTest()`
  - `createPluginHarness()` (suite-scoped)
  - `resolveObsidianEnvOptions()` / `verifyVaultPath()`
- `obsidian-e2e/matchers`
  - optional `expect` matchers for vault and sandbox assertions
- `obsidian-e2e/runner`
  - programmatic API for the instance runner (see below)
- `obsidian-e2e` bin
  - the `obsidian-e2e <provision|start|stop|run>` command

## Instance Runner (CLI)

The test helpers above assume Obsidian is already running against a vault the
`obsidian` CLI can reach. The instance runner is the piece that gets you there:
it stands up a **worktree-isolated** Obsidian instance - its own vault, its own
private `HOME`, and its own app process - so parallel git worktrees never collide
on one vault and a run never touches another plugin's instance or your day-to-day
Obsidian.

Each consumer keeps a small `obsidian-e2e.config.mjs` at the worktree root and
points four npm scripts at the bin. The runner adds zero runtime dependencies
(Node stdlib only).

### Why worktree isolation

- Two checkouts of the same plugin (e.g. a feature branch and `main`) each get a
  distinct vault name and a distinct `/tmp` profile, so their instances never
  fight over one `obsidian vault=dev`.
- The profile lives under a private `HOME`, so the CLI socket, keychain links, and
  `obsidian.json` registry are all scoped to that instance.
- A version guard refuses to run against an Obsidian build below the plugin's
  `minAppVersion`, turning a false "missing API" failure into an explicit error.

### Install and configure

```bash
pnpm add -D obsidian-e2e
```

Create `obsidian-e2e.config.mjs` at the worktree root. Only `pluginId` is
required; every other field has the default shown here:

```js
// obsidian-e2e.config.mjs
export default {
  pluginId: "your-plugin", // required; drives the plugin dir, community-plugins, reload id, ready probe
  vaultPrefix: "your-plugin", // default: pluginId. Vault name is `${vaultPrefix}-${worktree basename}`
  pluginArtifacts: ["manifest.json", "main.js"], // symlinked into the vault; add "styles.css" if you ship one
  defaultData: {}, // data.json seed on first provision
  buildCommand: "npm run build", // referenced in the "build first" error text
  defaultCommand: ["eval", "code=app.vault.getName()"], // the `run` subcommand default
  readyProbe: {
    // how the launcher confirms the plugin is live; the default is:
    kind: "eval",
    code: 'Boolean(app.plugins.plugins["your-plugin"])',
    match: "=> true",
  },
  envPrefix: undefined, // e.g. "YOURPLUGIN" to also emit legacy <PREFIX>_E2E_* aliases during migration
  profileRoot: "/tmp/your-plugin-obsidian-e2e", // private profile root
  appName: "Obsidian", // the .app name passed to `open -a`
  obsidianBin: "obsidian", // the obsidian CLI binary
};
```

Requirements are the same as the test helpers: Obsidian installed locally and the
`obsidian` CLI on `PATH`.

### Subcommands

Wire the bin into the same script names the AGENTS.md playbooks already use:

```jsonc
{
  "scripts": {
    "provision:e2e-vault": "obsidian-e2e provision",
    "start:e2e-obsidian": "obsidian-e2e start",
    "stop:e2e-obsidian": "obsidian-e2e stop",
    "obsidian:e2e": "obsidian-e2e run",
  },
}
```

- `provision` - lay down the worktree-local vault (write `.obsidian` config,
  symlink the plugin artifacts, seed `data.json`). Pure filesystem; never
  launches Obsidian.
- `start` - provision, prepare the private profile, guard the app version, then
  reuse-and-reload a warm instance or launch a fresh one and verify the plugin.
- `stop` - terminate this worktree's instance (SIGTERM, then SIGKILL for
  stragglers) and remove its profile. Safe to run when nothing is up.
- `run` - bring the instance up, then forward the command after the first
  non-option token (or after `--`) to the `obsidian` CLI. With no command, the
  config's `defaultCommand` runs.

```bash
# Provision only, and load the vault env into the current shell:
eval "$(pnpm run provision:e2e-vault -- --print-env)"

# Bring an instance up and export its env for a Vitest run:
eval "$(pnpm run start:e2e-obsidian -- --print-env)"

# Forward a command to the running instance's obsidian CLI:
pnpm run obsidian:e2e -- eval "code=app.vault.getName()"

# Tear the instance down, and also reap any instance whose worktree is gone:
pnpm run stop:e2e-obsidian -- --prune
```

Shared flags: `--vault --root --worktree --data --profile-root --obsidian-app
--obsidian-bin --config` (value) and `--force --json --help` (boolean).
Per-subcommand extras: `provision` adds `--print-env`; `start` adds `--print-env
--no-launch --skip-version-guard`; `stop` adds `--dry-run --prune`; `run` adds
`--skip-version-guard` and forwards everything after the first non-option token.

### Env contract

Under `--print-env`, `stdout` carries **only** `export` lines (so
`eval "$(...)"` is safe) and every human message goes to `stderr`. The canonical
names are always emitted; the legacy `<PREFIX>_E2E_*` aliases are emitted only
when `envPrefix` is set, so a harness can migrate off its old names at its own
pace.

| Variable                                                | Emitted by                 | Meaning                                                |
| ------------------------------------------------------- | -------------------------- | ------------------------------------------------------ |
| `OBSIDIAN_E2E_VAULT`                                    | `provision`, `start`       | the isolated vault name (harnesses default to `"dev"`) |
| `OBSIDIAN_E2E_VAULT_PATH`                               | `provision`, `start`       | absolute path to the provisioned vault                 |
| `OBSIDIAN_E2E_OBSIDIAN_HOME`                            | `start`                    | the private `HOME` for this instance                   |
| `OBSIDIAN_BIN`                                          | `start`                    | only when a non-default `--obsidian-bin` is set        |
| `<PREFIX>_E2E_VAULT` / `_VAULT_PATH` / `_OBSIDIAN_HOME` | both, when `envPrefix` set | legacy aliases during migration                        |

### Safety notes

- **Version guard.** `start` and `run` refuse to launch (or to reuse a warm
  instance across) an Obsidian app-code version below the plugin's
  `minAppVersion`, and hard-fail reuse when Obsidian updated mid-session (the
  running renderer no longer matches). Bypass with `--skip-version-guard`.
- **Secure `/tmp` handling.** The profile root defaults under world-writable
  `/tmp`. Every path that creates, reads, or removes inside it refuses a
  symlinked, foreign-owned, or group/other-accessible directory and fails closed
  rather than following a planted link.
- **Reaper semantics.** An instance is orphaned once its backing worktree is gone
  from disk (the signature of a worktree removed on merge). `start`/`run` reap
  orphans as a self-healing safety net, and `stop --prune` reaps them on demand;
  a running-but-leaked instance for a live worktree is never reaped.

### Archive-hook cleanup (orca)

When a worktree is archived, stop its instance so nothing leaks. The command is
best-effort (`|| true`) so archiving never fails on a stale instance:

```yaml
# orca.yaml
hooks:
  archive:
    - node_modules/.bin/obsidian-e2e stop --worktree "$ORCA_WORKTREE_PATH" || true
```

### Programmatic API

Everything the bin does is available from `obsidian-e2e/runner` for scripts that
need to orchestrate instances directly - `loadRunnerConfig`,
`resolveProvisionOptions`, `provisionVault`, `resolveInstanceOptions`,
`ensureObsidianInstance`, `stopInstance`, `reapOrphanedInstances`,
`runObsidianE2ECli`, and the supporting types.

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

For manual lifecycle setups, the same lock helpers are available directly from
the main package, so `obsidian-e2e/vitest` is not required:

```ts
import {
  acquireVaultRunLock,
  clearVaultRunLockMarker,
  createObsidianClient,
  type ObsidianClient,
  type VaultRunLock,
} from "obsidian-e2e";

let obsidian: ObsidianClient;
let lock: VaultRunLock;

beforeAll(async () => {
  obsidian = createObsidianClient({ vault: "dev" });
  await obsidian.verify();

  lock = await acquireVaultRunLock({
    vaultName: "dev",
    vaultPath: await obsidian.vaultPath(),
  });

  await lock.publishMarker(obsidian);
});

afterAll(async () => {
  await clearVaultRunLockMarker(obsidian);
  await lock.release();
});
```

For lock diagnostics, both `obsidian-e2e` and `obsidian-e2e/vitest` export:

```ts
import { inspectVaultRunLock, readVaultRunLockMarker } from "obsidian-e2e";

const state = await inspectVaultRunLock({
  vaultPath: "/absolute/path/to/dev-vault",
});

const marker = await readVaultRunLockMarker(obsidian);
```

`inspectVaultRunLock()` reads the authoritative host-side lock state and
returns the current metadata, lock directory, heartbeat age, and stale status.
`readVaultRunLockMarker()` reads the best-effort marker from the running
Obsidian app.

If you prefer manual `beforeAll` / `afterAll` lifecycle, you can import the
lock helpers directly from `obsidian-e2e`. You do not need
`obsidian-e2e/vitest` for that usage:

```ts
import { afterAll, beforeAll } from "vite-plus/test";
import {
  acquireVaultRunLock,
  clearVaultRunLockMarker,
  createObsidianClient,
  type VaultRunLock,
} from "obsidian-e2e";

const obsidian = createObsidianClient({ vault: "dev" });
let vaultLock: VaultRunLock | undefined;

beforeAll(async () => {
  await obsidian.verify();

  vaultLock = await acquireVaultRunLock({
    vaultName: obsidian.vaultName,
    vaultPath: await obsidian.vaultPath(),
  });

  await vaultLock.publishMarker(obsidian);
});

afterAll(async () => {
  await clearVaultRunLockMarker(obsidian);
  await vaultLock?.release();
});
```

Within one worker/process, reacquiring the same shared-vault lock is reentrant:
the existing lease is reused instead of contending against itself. Across
different processes or worktrees, contention still serializes access through
the host-side lock.

The lock path is covered by a real multi-process smoke test: one process can
hold the lease while another waits, and a second process can also take over
after the original holder dies and its heartbeat goes stale.

The fixture layer is also covered the same way: separate `createObsidianTest()`
runs can contend for the same `sharedVaultLock`, and the smoke path verifies
that one run waits until the other releases or goes stale. That proves lock
handoff across process boundaries, not safe parallel mutation inside one vault.

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

  await sandbox.writeNote({
    path: "tpl.md",
    frontmatter: {
      tags: ["template"],
    },
    body: "template body",
  });
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
  - exposes note helpers such as `writeNote()`, `readNote()`, and `path()`

Plugin data mutations are snapshotted on first write and restored automatically
after each test. Sandbox files are also cleaned up automatically.

## Note Helpers And Test Context

Use `sandbox.writeNote()` when the test cares about note structure rather than
raw YAML formatting:

```ts
await sandbox.writeNote({
  path: "Inbox/Today.md",
  frontmatter: {
    mood: "focused",
    tags: ["daily"],
  },
  body: "# Today\n",
});

await expect(sandbox.readNote("Inbox/Today.md")).resolves.toMatchObject({
  body: "# Today\n",
  frontmatter: {
    mood: "focused",
    tags: ["daily"],
  },
});

await obsidian.metadata.waitForFrontmatter(sandbox.path("Inbox/Today.md"), (frontmatter) =>
  frontmatter.tags.includes("daily"),
);
```

`readNote()` is file-derived. Metadata-cache reads stay under
`obsidian.metadata.*`, so tests can distinguish raw file content from
“Obsidian has indexed this note”.

Outside Vitest fixtures, use the public lifecycle wrapper:

```ts
import { withVaultSandbox } from "obsidian-e2e";

await withVaultSandbox(
  {
    testName: "quickadd smoke",
    vault: "dev",
  },
  async (context) => {
    const plugin = await context.plugin("quickadd", {
      filter: "community",
      seedData: { enabled: true },
    });

    await context.sandbox.writeNote({
      path: "fixtures/template.md",
      body: "Hello from template",
    });

    await plugin.reload();
  },
);
```

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
    "fixtures/template.md": {
      note: {
        body: "template body",
        frontmatter: {
          tags: ["template"],
        },
      },
    },
    "fixtures/state.json": { json: { ready: true } },
  },
});
```

`createPluginTest()`:

- injects `plugin` alongside `obsidian`, `vault`, and `sandbox`
- enables the target plugin for the test when needed and restores the prior
  enabled/disabled state afterward
- seeds vault files before each test and restores the original files afterward
  - `seedVault` accepts raw strings, `{ json }`, and `{ note }` descriptors
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

## Suite-Scoped Plugin Harness

`createPluginTest()` is per-test: it reloads the plugin and sandboxes the vault
for every `test()`. Some suites instead want one reload and one sandbox for the
whole file, restoring only `data.json` between tests. `createPluginHarness()`
covers that shape while reusing the same lock, sandbox, artifact, and restore
internals - so you never hand-roll `beforeAll`/`afterEach`/`afterAll`.

It returns a `(testName) => () => { obsidian, plugin, sandbox }` factory. Call it
once per suite to register the lifecycle hooks; the returned getter yields the
live context inside each test:

```ts
import { createPluginHarness, resolveObsidianEnvOptions } from "obsidian-e2e/vitest";
import { expect } from "vite-plus/test";

const usePodNotes = createPluginHarness({
  pluginId: "podnotes",
  // Canonical OBSIDIAN_E2E_* env, with a legacy per-plugin prefix fallback.
  ...resolveObsidianEnvOptions({ legacyPrefix: "PODNOTES" }),
  reload: { readyCommandId: "podnotes:podnotes-show-leaf", timeoutMs: 30_000 },
  // Extra readiness beyond plugin-loaded + ready command.
  waitUntilReady: (obsidian) =>
    obsidian.dev.evalJson<boolean>("Boolean(app.plugins.plugins.podnotes?.api)"),
  // Runs while the plugin is still enabled, before each data.json restore.
  beforeDataRestore: (obsidian) =>
    obsidian.dev.evalJsonAsync(
      "(async () => { await app.plugins.plugins.podnotes?.saveChain; })()",
    ),
  symlinkArtifacts: ["main.js", "manifest.json"],
  captureOnFailure: true,
});

const getContext = usePodNotes("podnotes-runtime");

test("keeps the API available after a data reset", async () => {
  const { obsidian, plugin, sandbox } = getContext();
  await sandbox.writeNote({ path: "note.md", body: "hi" });
  await expect(plugin.isEnabled()).resolves.toBe(true);
});
```

Lifecycle: `beforeAll` acquires the vault lock and marker, runs the optional
symlink preflight, creates the sandbox, then reloads the plugin and waits for the
ready command plus your `waitUntilReady` predicate. `beforeEach` resets
diagnostics; `afterEach` runs `beforeDataRestore`, restores `data.json`, and
re-readies the plugin. `afterAll` runs an ordered, error-aggregating teardown:
plugin data restore, then sandbox removal, then in-app lock-marker clear, and
only then the vault-lock release - so a waiting run never acquires the vault
mid-cleanup. A failed marker clear fails the suite instead of being swallowed,
since it means Obsidian retained stale ownership metadata.

`resolveObsidianEnvOptions()` maps the canonical `OBSIDIAN_E2E_VAULT`,
`OBSIDIAN_E2E_VAULT_PATH`, and `OBSIDIAN_E2E_OBSIDIAN_HOME` env (with an optional
`legacyPrefix` fallback such as `PODNOTES_E2E_VAULT`) into spreadable client
options. The Obsidian home is injected into `defaultExecOptions.env.HOME`
per-client, never mutating `process.env`. Pair the returned `expectedVaultPath`
with `verifyVaultPath()` (or set it on the harness) to refuse running against the
wrong vault.

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
- `active-note.md`
- `active-note-frontmatter.json`
- `console-messages.json`
- `dom.txt`
- `editor.json`
- `notices.json`
- `runtime-errors.json`
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

If you are not using the Vitest fixtures, the same artifact capture path is
available directly from the main package:

```ts
import { captureFailureArtifacts, createObsidianClient } from "obsidian-e2e";

const obsidian = createObsidianClient({ vault: "dev" });

await captureFailureArtifacts(
  {
    id: "quickadd_case_1234abcd",
    name: "captures quickadd diagnostics",
  },
  obsidian,
  {
    captureOnFailure: true,
    plugin: obsidian.plugin("quickadd"),
  },
);
```

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
- `toHaveFrontmatter(path, expected)`
- `toHaveJsonFile(path)`
- `toHaveNote(path, { frontmatter?, body?, bodyIncludes? })`
- `toHaveOpenTab(title, viewType?)`
- `toHavePluginData(expected)`
- `toHaveWorkspaceNode(label)`

Example:

```ts
import { expect } from "vite-plus/test";
import { test } from "./setup";

test("writes valid JSON into the sandbox", async ({ sandbox }) => {
  await sandbox.writeNote({
    path: "Today.md",
    frontmatter: {
      mood: "focused",
    },
    body: "# Today\n",
  });

  await expect(sandbox).toHaveNote("Today.md", {
    bodyIncludes: "Today",
    frontmatter: {
      mood: "focused",
    },
  });
  await expect(sandbox).toHaveFrontmatter("Today.md", {
    mood: "focused",
  });
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
import { createObsidianClient, createVaultApi, parseNoteDocument } from "obsidian-e2e";

const obsidian = createObsidianClient({
  vault: "dev",
  bin: "obsidian",
  defaultExecOptions: {
    allowNonZeroExit: true,
  },
});
const vault = createVaultApi({ obsidian });

await obsidian.verify();
await vault.write("Inbox/Today.md", "# Today\n", { waitForContent: true });
await expect(await obsidian.metadata.frontmatter("Inbox/Today.md")).toBeNull();
await obsidian.plugin("my-plugin").reload({
  waitUntilReady: true,
  readyOptions: {
    commandId: "my-plugin:refresh",
  },
});
parseNoteDocument(await vault.read("Inbox/Today.md"));
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
- `obsidian.dev.evalJson(code)`
- `obsidian.dev.evalJsonAsync(code)`
- `obsidian.dev.evalRaw(code)`
- `obsidian.dev.diagnostics()`
- `obsidian.dev.resetDiagnostics()`
- `obsidian.metadata.fileCache(path)`
- `obsidian.metadata.frontmatter(path)`
- `obsidian.metadata.waitForFileCache(path, predicate?)`
- `obsidian.metadata.waitForFrontmatter(path, predicate?)`
- `obsidian.metadata.waitForMetadata(path, predicate?)`
- `obsidian.dev.screenshot(path)`
- `obsidian.tabs()`
- `obsidian.workspace()`
- `obsidian.open({ file? | path?, newTab? })`
- `obsidian.openTab({ file?, group?, view? })`
- `obsidian.sleep(ms)`
- `obsidian.waitForActiveFile(path)`
- `obsidian.waitForConsoleMessage(predicate)`
- `obsidian.waitForNotice(predicate)`
- `obsidian.waitForRuntimeError(predicate)`

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

## Vault, Metadata, And Plugin Wait Helpers

The higher-level vault and plugin handles now expose the most common polling
patterns directly, so tests do not need to hand-roll `waitFor()` loops around
content reads, command discovery, or plugin data migration:

```ts
test("waits for generated content and plugin state", async ({ obsidian, sandbox, vault }) => {
  const plugin = obsidian.plugin("quickadd");

  await vault.write("queue.md", "pending", {
    waitForContent: true,
  });

  await vault.waitForContent("queue.md", (content) => content.includes("pending"));
  await sandbox.writeNote({
    path: "Inbox/Today.md",
    frontmatter: {
      tags: ["daily"],
    },
    body: "# Today\n",
  });
  await obsidian.metadata.waitForFrontmatter(sandbox.path("Inbox/Today.md"), (frontmatter) =>
    frontmatter.tags.includes("daily"),
  );

  await plugin.updateDataAndReload<{ migrations: Record<string, boolean> }>((draft) => {
    draft.migrations.quickadd_v2 = true;
  });

  await plugin.waitForData<{ migrations: Record<string, boolean> }>(
    (data) => data.migrations.quickadd_v2 === true,
  );
});
```

If you just need time to pass without inventing a fake polling condition, use
`await obsidian.sleep(ms)`.

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

`obsidian.dev.eval()` remains the low-level escape hatch and preserves the raw
CLI parsing behavior. Use `obsidian.dev.evalJson()` when you want JSON-safe
typed results and remote error details, `obsidian.dev.evalJsonAsync()` when the
evaluated code is an async body whose resolved value you need, and
`obsidian.dev.evalRaw()` when you intentionally need the unstructured CLI output.
The `evalJson`/`evalJsonAsync` envelope is wrapped in per-call sentinel markers,
so plugin console output emitted on the eval channel while the code runs (e.g.
`QuickAdd: ...` notices) cannot corrupt the parsed result - no window-global
polling workaround is needed for logging-heavy operations. `dev.dom()` and
`dev.screenshot()` remain the safer wrappers around the built-in developer CLI
commands. Screenshot behavior depends on the active desktop environment, so
start by validating it locally before relying on it in automation.

### How `evalJsonAsync` awaits long operations

A single `obsidian eval` CLI command holds one socket request open for the whole
lifetime of an awaited promise, and its reply is the only carrier of the result:
a timeout kill or a renderer reload mid-eval loses the value forever even when
the operation itself completed (#21). `evalJsonAsync` therefore never holds a
long command open. It sends a short kickoff command exactly once - the command
starts the operation and records its eventual `{ ok, value }` envelope under a
per-operation nonce inside the app - then retrieves the envelope with short
idempotent poll reads. A lost reply is recovered by simply reading again, and
because the kickoff is never resent, the evaluated code cannot run twice.

`timeoutMs` (per call or via `defaultExecOptions`) is the overall deadline for
the awaited result; each internal CLI command runs on its own short budget.
Successful results resolve the value and rethrow in-app failures as
`DevEvalError`, exactly as before. When the result cannot be produced, the call
throws `DevEvalAsyncError` whose `reason` names the precise transport state
instead of a generic timeout:

- `ambiguous-delivery`: the kickoff command failed or its reply was lost, and
  no in-app record of the operation appeared before the deadline; it may or may
  not have started. The kickoff is never resent, preserving exactly-once
  execution; the underlying CLI failure is attached as `causeError`.
- `context-reset`: the operation was confirmed running and then the eval
  context was wiped (e.g. an app or vault reload); the result was discarded
  with the previous context.
- `still-pending`: the awaited promise has not settled within the deadline; the
  operation may still complete in-app afterwards.

Hand-rolled fire-and-poll loops (a `window` global plus repeated short
`evalJson` reads) are obsolete: `evalJsonAsync` is that pattern, managed by the
package.

### How `exec()` recovers lost CLI replies

Every CLI command's reply crosses Obsidian's main-to-renderer bridge exactly
once, and that bridge loses or delays messages under suite load - a command can
complete in-app in milliseconds while its reply never reaches the CLI client,
which then hangs until the transport kills it (#25). `exec()` therefore wraps
commands in a dispatch protocol: a one-time shim around the in-app CLI
dispatcher records each command's reply under a per-call nonce before running
it, so a lost reply is recovered by short idempotent poll reads instead of
timing out. Recovery never re-sends a command without positive proof it did
not run: the shim dedups repeated nonces, refuses payloads pinned to a
previous shim generation (an app reload), and a reply that cannot be
positively identified counts as unknown fate rather than as proof of
non-execution. `quickadd:run`-style non-idempotent commands stay
exactly-once.
The command's handler sees its exact original argv, and the recovered
`ExecResult` is byte-identical to the direct CLI output (including exit code 0
for `Error: ...` replies).

The happy path stays a single CLI roundtrip. On the recoverable path,
`timeoutMs` is the overall deadline for the command's result; the dispatch
attempt and the internal polls run on their own short budgets, so a
long-running command no longer dies with the 30s socket hold either.
Everything built on `exec()` - `dev.eval`, `dev.evalJson`, `command(id).run()`,
`plugin(id).reload()`, and the `evalJsonAsync` internals - gains the same
recovery automatically.

Defaults: recoverable on the built-in transport, direct on a custom
`transport` (a test fake cannot serve the protocol - note this also applies to
transports that merely wrap the built-in one for logging; opt back in with
`recoverable: true`). `reload`, `restart`, `plugins:restrict`, and
`dev:mobile` always use the direct path because their success destroys the
renderer context the recovery registry lives in, as does `command` with the
context-destroying built-in ids (`app:reload`, `app:quit`); plugin commands
whose handlers reload the app cannot be enumerated, so route those through
`recoverable: false` yourself. Override per call or via `defaultExecOptions`
with `recoverable: true | false`.

When the result cannot be produced, `exec()` throws
`ObsidianCommandDispatchError` whose `reason` names the precise transport
state:

- `ambiguous-delivery`: no dispatch attempt was acknowledged and no in-app
  record appeared; the command may or may not have started, and cannot have
  run twice.
- `context-reset`: the renderer context was reset while an attempt was in
  flight; whether the command executed before the reset is unknowable.
- `still-pending`: the command is confirmed running in-app but has not settled
  within the deadline.
- `undelivered`: the dispatch shim could not be installed; the command was
  never dispatched and did not run, so retrying is safe.

## Layer Boundaries

- `vault` stays filesystem-only. If the behavior depends on Obsidian parsing or
  workspace state, it does not belong there.
- `sandbox.readNote()` parses file content only. It does not imply that
  Obsidian has indexed the note.
- `obsidian.metadata.*` reads metadata-cache state, which is the right layer
  for frontmatter synchronization and race-sensitive tests.
- `obsidian.dev.eval()` is the escape hatch. Prefer the higher-level metadata,
  sandbox, wait, plugin, and matcher helpers first, and use
  `obsidian.dev.evalJson()` when you need structured JSON-safe results.

## Migration Notes

- Keep using `obsidian.dev.eval()` for the raw escape hatch semantics.
- Use `obsidian.dev.evalJson()` when you want JSON-safe typed results and
  `DevEvalError` stack details.
- Use `obsidian.metadata.*` for metadata-cache synchronization, including notes
  created under `sandbox.path(...)`.
- Prefer `sandbox.writeNote()` over hand-built YAML strings when the test is
  describing note content rather than string formatting.
- Prefer `plugin.updateDataAndReload()` or `plugin.withPatchedData()` over open-
  coded patch/reload/restore sequences.

## Regression Matrix

- Metadata waits cover delayed file-cache population and frontmatter
  synchronization after note writes.
- Failure artifacts capture active note content, parsed frontmatter, recent
  console/notices/runtime errors, and workspace snapshots.
- Lifecycle cleanup restores tracked plugin data before disabling plugins,
  removes sandbox content and clears the in-app lock marker before releasing
  the vault lock, and surfaces marker-clear failures instead of swallowing them.

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
