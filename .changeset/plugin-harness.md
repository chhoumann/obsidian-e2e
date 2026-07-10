---
"obsidian-e2e": minor
---

Add suite-scoped plugin harness, async JSON eval, and an env resolver.

These three additive helpers let plugin repos drop their hand-rolled e2e harness
boilerplate:

- `obsidian.dev.evalJsonAsync(code)` awaits an async body inside Obsidian and
  decodes the same `{ ok, value }` envelope as `evalJson`, rethrowing failures as
  a `DevEvalError` with the remote message and stack.
- `resolveObsidianEnvOptions()` maps the canonical `OBSIDIAN_E2E_VAULT` /
  `OBSIDIAN_E2E_VAULT_PATH` / `OBSIDIAN_E2E_OBSIDIAN_HOME` env (with an optional
  legacy per-plugin prefix fallback) into spreadable client options, injecting
  `HOME` into `defaultExecOptions.env` per-client without mutating `process.env`.
  `verifyVaultPath()` refuses to run against the wrong vault.
- `createPluginHarness()` (from `obsidian-e2e/vitest`) is a suite-scoped fixture
  that reuses the existing lock, sandbox, artifact, and restore internals: one
  reload and sandbox per file, optional symlink preflight, per-test diagnostics
  reset, a `beforeDataRestore` hook before each `data.json` restore, and an
  ordered error-aggregating teardown. It returns the
  `(testName) => () => { obsidian, plugin, sandbox }` getter the hand-rolled
  harnesses already expose.

Also adds an optional `predicate` to `PluginWaitUntilReadyOptions` so
`plugin.reload({ readyOptions: { predicate } })` can assert readiness beyond the
ready command. All additive; no existing exports change.
