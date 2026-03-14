# obsidian-e2e V2 Plan

## Goals

- Evolve `obsidian-e2e` from a filesystem-oriented helper into an Obsidian-aware
  e2e framework.
- Add first-class app, command, and workspace primitives on top of the existing
  low-level client.
- Keep the framework plugin-agnostic while making common Obsidian interactions
  expressible without bespoke shell code in every test.
- Preserve the current lightweight package shape: library-only, Vitest-first,
  and built through Vite+ plus tsdown.

## Task Graph

- [x] `V1` Add V2 plan and scope the initial implementation slice
  - depends_on: []
- [x] `V2` Extend client types with app and command interfaces
  - depends_on: [`V1`]
- [x] `V3` Implement app lifecycle primitives
  - depends_on: [`V2`]
- [x] `V4` Implement command discovery and execution helpers
  - depends_on: [`V2`]
- [x] `V5` Export the new app and command APIs from the public surface
  - depends_on: [`V3`, `V4`]
- [x] `V6` Add focused tests for app and command behavior
  - depends_on: [`V3`, `V4`, `V5`]
- [x] `V7` Document the new APIs and usage patterns
  - depends_on: [`V5`]
- [x] `V8` Add workspace inspection and note-opening primitives
  - depends_on: [`V3`, `V4`, `V6`]
- [x] `V9` Add higher-level fixture helpers for plugin-under-test and seeded vaults
  - depends_on: [`V8`]
- [x] `V10` Add richer matchers for active file, commands, plugin data, and editor state
  - depends_on: [`V8`, `V9`]
- [x] `V11` Add developer-mode helpers around `eval`, DOM inspection, and screenshots
  - depends_on: [`V8`]
- [x] `V12` Expand docs and examples to cover real plugin-testing workflows
  - depends_on: [`V9`, `V10`, `V11`]

## Initial Slice

The first implementation slice is `V2` through `V7`.

This slice adds the primitives that are immediately useful in real tests and
also act as building blocks for the later workspace and fixture layers:

- `obsidian.app.version()`
- `obsidian.app.reload()`
- `obsidian.app.restart()`
- `obsidian.app.waitUntilReady()`
- `obsidian.commands(options?)`
- `obsidian.command(id).run()`
- `obsidian.command(id).exists()`

## Planned Follow-Up Areas

- `V8` should add `workspace()` and `tabs()` readers plus `open()` helpers.
- `V9` should add a first-class plugin-under-test fixture that can enable,
  disable, reload, and seed plugin state cleanly.
- `V10` should make the test surface more declarative with Obsidian-specific
  matchers instead of raw filesystem assertions.
- `V11` should expose the developer CLI affordances safely so tests can inspect
  DOM state when filesystem and command-level assertions are not enough.

## Constraints

- Keep new APIs grounded in real `obsidian` CLI commands that exist today.
- Avoid making plugin-specific assumptions.
- Keep new behavior testable through mocked transports so the unit suite remains
  fast and deterministic.
- Do not break the existing fixture API or package entrypoints.

## Status

- Completed: `V1`, `V2`, `V3`, `V4`, `V5`, `V6`, `V7`, `V8`, `V9`, `V10`, `V11`, `V12`
- In progress: none
- Pending: none

## Work Log

- Created the V2 roadmap and selected app plus command primitives as the first
  implementation slice because they map directly to the installed Obsidian CLI
  and unlock later workspace-aware helpers.
- Added `obsidian.app.*` primitives for version, reload, restart, and readiness
  polling.
- Added `obsidian.commands()` and `obsidian.command(id)` helpers for discovery
  and execution.
- Exported the new client-side types from the package root and covered the new
  behavior with focused transport-level tests.
- Documented the new app and command APIs in the README with a realistic
  command-driven test example.
- Added parsed `workspace()` and `tabs()` readers plus `open()` and `openTab()`
  helpers backed by the real Obsidian CLI commands.
- Covered workspace parsing, tab parsing, and note-opening argv construction
  with focused client tests.
- Added `createPluginTest()` with a dedicated `plugin` fixture, automatic
  enable/disable handling, `seedVault`, and `seedPluginData` support.
- Covered the plugin fixture helper with a focused fixture-level test and
  documented the workflow in the README.
- Added richer Obsidian-aware matchers for active file, commands, editor text,
  open tabs, workspace nodes, and plugin data.
- Added the low-level `obsidian.dev.eval()` primitive that the new stateful
  matchers build on top of.
- Expanded the `dev` namespace with DOM inspection and screenshot helpers and
  documented those developer-mode workflows in the README.
- Added a cohesive end-to-end workflow example showing `createPluginTest()`,
  seeded state, Obsidian-aware matchers, and `dev` helpers working together.

## Files Modified or Created

- `./src/index.ts`
- `./src/core/client.ts`
- `./src/core/types.ts`
- `./src/plugin/plugin.ts`
- `./src/fixtures/create-plugin-test.ts`
- `./src/matchers.ts`
- `./tests/core/client.test.ts`
- `./tests/fixtures/create-plugin-test.test.ts`
- `./tests/matchers.test.ts`
- `./README.md`
- `./v2-plan.md`

## Errors or Gotchas

- The local `obsidian --help` output shows a richer command surface than the
  original scaffold assumed, so V2 should lean on real app, command, workspace,
  and developer commands rather than adding speculative abstractions.
- A few older unit-test client stubs had to be expanded once the `ObsidianClient`
  interface gained app and command members.
- The CLI's `workspace ids` output is tree-structured text rather than JSON, so
  `workspace()` currently relies on a parser for the observed line format.
- The shared base fixtures are now factored out internally, but `createPluginTest()`
  still uses its own top-level `extend()` call so it can keep the seeded `vault`
  behavior explicit under the current `vite-plus/test` typing model.
- Screenshot support is now a thin wrapper around `obsidian dev:screenshot`; the
  command itself is environment-sensitive, so local validation matters before
  depending on it in CI.
- The README now covers the main supported workflows; future docs work is more
  likely to be cookbook/examples expansion than API-shape discovery.
