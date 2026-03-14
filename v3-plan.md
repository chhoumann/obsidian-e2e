# obsidian-e2e V3 Plan

## Goals

- Make test failures cheap to diagnose by capturing useful artifacts
  automatically.
- Reuse the existing fixture layer so artifact capture works consistently for
  both `createObsidianTest()` and `createPluginTest()`.
- Keep the artifact system opt-in and filesystem-backed first, with test-runner
  artifact integration where available.

## Task Graph

- [x] `W1` Add the V3 plan and scope the first artifact slice
  - depends_on: []
- [x] `W2` Extend fixture options with failure artifact configuration
  - depends_on: [`W1`]
- [x] `W3` Implement artifact directory planning and path sanitization
  - depends_on: [`W2`]
- [x] `W4` Implement failure capture in the shared fixture layer
  - depends_on: [`W2`, `W3`]
- [x] `W5` Capture Obsidian state artifacts on failure
  - depends_on: [`W4`]
- [x] `W6` Capture plugin-specific artifacts for `createPluginTest()`
  - depends_on: [`W4`, `W5`]
- [x] `W7` Add focused tests for artifact planning and failure hooks
  - depends_on: [`W4`, `W5`, `W6`]
- [x] `W8` Document failure artifacts in the README
  - depends_on: [`W5`, `W6`]
- [ ] `W10` Add CI/release hardening for artifact-aware validation
  - depends_on: [`W5`, `W7`, `W8`]

## Initial Slice

The first implementation slice is `W2` through `W8`.

That slice should add:

- fixture options such as `artifactsDir` and `captureOnFailure`
- per-test artifact directories under a deterministic root
- automatic failure capture for:
  - screenshot path attempts
  - DOM text snapshots
  - active file
  - open tabs
  - workspace tree
  - plugin `data.json` when a plugin fixture is present
- README guidance on where artifacts go and how to inspect them

## Constraints

- Preserve the current fixture APIs and behavior when artifact capture is not
  enabled.
- Keep artifact capture resilient: failures while collecting artifacts must not
  hide the original test failure.
- Prefer plain files first; add runner metadata only as a progressive
  enhancement.

## Status

- Completed: `W1`, `W2`, `W3`, `W4`, `W5`, `W6`, `W7`, `W8`
- In progress: none
- Pending: `W10`

## Work Log

- Confirmed the local `vite-plus/test` surface exposes per-test
  `context.onTestFailed(...)` hooks and `recordArtifact(...)`, which is enough
  to build failure artifact capture into the shared fixture layer.
- Added opt-in fixture options for failure artifact capture and a shared helper
  path so both `createObsidianTest()` and `createPluginTest()` register the same
  failure hooks.
- Implemented deterministic artifact directory planning plus best-effort file
  capture for active file, DOM, editor text, tabs, workspace state, screenshot
  attempts, and plugin data snapshots.
- Added focused tests around artifact planning and failure capture, then
  documented the new `artifactsDir` and `captureOnFailure` options in the
  README.

## Files Modified or Created

- `./README.md`
- `./src/fixtures/base-fixtures.ts`
- `./src/fixtures/create-plugin-test.ts`
- `./src/fixtures/failure-artifacts.ts`
- `./src/fixtures/types.ts`
- `./tests/fixtures/failure-artifacts.test.ts`
- `./v3-plan.md`

## Errors or Gotchas

- `dev:screenshot` appears environment-sensitive in the current desktop setup,
  so the first slice should treat screenshot capture as best-effort rather than
  guaranteed.
- Artifact capture must never hide the original assertion failure, so failed
  reads are written as neighboring `*.error.txt` files instead of surfacing a
  second failure from teardown.
